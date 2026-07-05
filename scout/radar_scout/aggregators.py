from __future__ import annotations

"""Aggregator firehose: scrape research-job boards (Madgex platform: Nature
Careers, Science Careers; HigherEdJobs best-effort), tag each job with its
employer, and write snapshots for the radar's aggregated importer.

The cap-exempt filter itself lives in the Node importer, but the scraper uses
the cap-exempt directory (radar/data/cap-exempt-directory.json) to decide
which jobs deserve a detail fetch for the full description.
"""

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .logging_utils import get_logger
from .net import UA, robots_advisory, throttle

log = get_logger("aggregators")

SCHEMA_VERSION = 1

# --- Name normalization: MUST mirror radar/scripts/lib/entity-resolution.js ---
LEGAL_SUFFIXES = re.compile(r"\b(THE|INC|INCORPORATED|LLC|LLP|LP|LTD|CORP|CORPORATION|CO|COMPANY|PC|PLLC)\b")
STOPWORDS = {"OF", "AND", "AT", "IN", "FOR"}


def normalize_name(value: str) -> str:
    text = (value or "").upper().replace("&", " AND ")
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    text = LEGAL_SUFFIXES.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def token_key(value: str) -> str:
    tokens = [t for t in normalize_name(value).split(" ") if t and t not in STOPWORDS]
    return " ".join(sorted(tokens))


class CapExemptDirectory:
    def __init__(self, entries: dict):
        self.by_normalized = entries
        self.by_token_key = {}
        for key, entry in entries.items():
            tk = entry.get("token_key") or ""
            if tk and tk not in self.by_token_key:
                self.by_token_key[tk] = key

    @classmethod
    def load(cls, radar_path: Path) -> "CapExemptDirectory | None":
        path = radar_path / "radar" / "data" / "cap-exempt-directory.json"
        if not path.exists():
            return None
        return cls(json.loads(path.read_text("utf-8")).get("entries", {}))

    def match(self, employer_name: str) -> dict | None:
        normalized = normalize_name(employer_name)
        if not normalized:
            return None
        entry = self.by_normalized.get(normalized)
        if entry:
            return entry
        tk = token_key(employer_name)
        key = self.by_token_key.get(tk)
        return self.by_normalized.get(key) if key else None


# --- Source configs -----------------------------------------------------------

@dataclass
class MadgexSource:
    name: str
    list_url: str          # includes filters; {page} placeholder appended
    base_url: str
    max_pages: int = 15
    item_selector: str = "li.lister__item"
    title_selector: str = "h3.lister__header a"
    employer_selector: str = ".lister__meta-item--recruiter"
    location_selector: str = ".lister__meta-item--location"


MADGEX_SOURCES = {
    "nature-careers": MadgexSource(
        name="nature-careers",
        list_url="https://www.nature.com/naturecareers/jobs/?countrycode=US&Page={page}",
        base_url="https://www.nature.com",
    ),
    "science-careers": MadgexSource(
        name="science-careers",
        list_url="https://jobs.sciencecareers.org/searchjobs/?countrycode=US&Page={page}",
        base_url="https://jobs.sciencecareers.org",
    ),
}


def build_snapshot(source: str, source_url: str, jobs: list[dict], skipped_reason: str | None = None) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "source": source,
        "scouted_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_url": source_url,
        "jobs": jobs,
        "skipped_reason": skipped_reason,
    }


def _clean(text: str | None) -> str:
    return " ".join((text or "").split())


def _extract_description(html: str) -> str:
    try:
        import trafilatura

        return (trafilatura.extract(html, include_comments=False, include_images=False) or "")[:8000]
    except Exception:
        return ""


def scrape_madgex(source: MadgexSource, page_obj, max_pages: int | None = None) -> list[dict]:
    """Walk the paginated listing; each card carries title/url/employer/location."""
    jobs: list[dict] = []
    seen_urls: set[str] = set()
    pages = max_pages or source.max_pages
    for page_number in range(1, pages + 1):
        url = source.list_url.format(page=page_number)
        if not robots_advisory(url):
            log.info("robots_disallow_advisory", source=source.name, url=url)
        throttle(url, 2)
        try:
            page_obj.goto(url, wait_until="domcontentloaded", timeout=45000)
            page_obj.wait_for_timeout(1500)
        except Exception as error:
            log.warning("list_page_failed", source=source.name, page=page_number, error=str(error))
            break
        cards = page_obj.query_selector_all(source.item_selector)
        if not cards:
            break
        new_on_page = 0
        for card in cards:
            title_el = card.query_selector(source.title_selector)
            if not title_el:
                continue
            href = title_el.get_attribute("href") or ""
            if not href:
                continue
            job_url = href.strip()
            if job_url.startswith("/"):
                job_url = source.base_url + job_url
            job_url = job_url.split("?")[0]
            if job_url in seen_urls:
                continue
            seen_urls.add(job_url)
            employer_el = card.query_selector(source.employer_selector)
            location_el = card.query_selector(source.location_selector)
            employer_name = _clean(employer_el.inner_text() if employer_el else "")
            if not employer_name:
                continue
            jobs.append({
                "title": _clean(title_el.inner_text()),
                "url": job_url,
                "employer_name": employer_name,
                "location": _clean(location_el.inner_text() if location_el else ""),
                "description_text": "",
            })
            new_on_page += 1
        log.info("list_page_done", source=source.name, page=page_number, new=new_on_page, total=len(jobs))
        if new_on_page == 0:
            break
    return jobs


def load_description_cache(radar_path: Path) -> dict[str, str]:
    """Previously fetched descriptions from the committed aggregated store,
    keyed by job URL. Reusing them means each run's detail budget goes only to
    jobs we have never read, so description coverage converges over runs
    instead of re-reading the same top-of-list postings forever."""
    store_path = radar_path / "radar" / "data" / "aggregated-jobs.json"
    try:
        store = json.loads(store_path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    cache = {}
    for job in store.get("jobs", []):
        url = job.get("url")
        description = str(job.get("description_text") or "").strip()
        if url and description:
            cache[url] = description
    return cache


def prefill_descriptions(jobs: list[dict], cache: dict[str, str] | None) -> int:
    """Fill description_text from the cache for jobs we already read."""
    reused = 0
    for job in jobs:
        if not job.get("description_text") and cache and job["url"] in cache:
            job["description_text"] = cache[job["url"]]
            reused += 1
    return reused


def fetch_details(jobs: list[dict], directory: "CapExemptDirectory | None", page_obj, cap: int = 60,
                  cache: dict[str, str] | None = None) -> int:
    """Fetch full descriptions, prioritizing jobs at cap-exempt employers —
    those are the ones the importer will keep, so they deserve the budget.
    Jobs already described (via the cache) never spend budget."""
    reused = prefill_descriptions(jobs, cache)
    if reused:
        log.info("details_reused", count=reused)

    def priority(job: dict) -> int:
        if directory and directory.match(job["employer_name"]):
            return 0
        return 1

    fetched = 0
    for job in sorted(jobs, key=priority):
        if fetched >= cap:
            break
        if job.get("description_text"):
            continue  # already described via cache or an earlier pass
        if directory and not directory.match(job["employer_name"]):
            continue  # never spend budget on employers the importer will drop
        throttle(job["url"], 2)
        fetched += 1
        try:
            page_obj.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
            job["description_text"] = _extract_description(page_obj.content())
        except Exception as error:
            log.warning("detail_failed", url=job["url"], error=str(error))
    return fetched


def scrape_higheredjobs(page_obj, max_pages: int = 10) -> tuple[list[dict], str | None]:
    """Best-effort HigherEdJobs scrape. The site sits behind Imperva; a real
    browser session usually passes after the homepage warm-up. Structure is a
    plain results list with details.cfm links; employer is the line after the
    title in each row."""
    base = "https://www.higheredjobs.com"
    try:
        throttle(base, 2)
        page_obj.goto(base, wait_until="domcontentloaded", timeout=45000)
        page_obj.wait_for_timeout(2500)
        search_url = f"{base}/search/advanced_action.cfm?Keyword=research&PosType=1&InstType=1%2C2&Remote=1%2C2&Region=&Submit=Search+Jobs"
        throttle(search_url, 2)
        page_obj.goto(search_url, wait_until="domcontentloaded", timeout=45000)
        page_obj.wait_for_timeout(2500)
        body = page_obj.inner_text("body").lower()
        if any(marker in body for marker in ("_incapsula_", "additional security check", "request unsuccessful")):
            return [], "bot_wall"
        jobs: list[dict] = []
        seen: set[str] = set()
        for page_number in range(max_pages):
            rows = page_obj.query_selector_all("div.row.record, div.record")
            for row in rows:
                link = row.query_selector("a[href*='details.cfm']")
                if not link:
                    continue
                href = link.get_attribute("href") or ""
                job_url = href if href.startswith("http") else base + "/" + href.lstrip("/")
                job_url = job_url.split("&aID=")[0]
                if job_url in seen:
                    continue
                seen.add(job_url)
                lines = [l.strip() for l in row.inner_text().split("\n") if l.strip()]
                title = _clean(link.inner_text())
                employer = lines[1] if len(lines) > 1 and _clean(lines[0]) == title else (lines[1] if len(lines) > 1 else "")
                if not title or not employer:
                    continue
                jobs.append({
                    "title": title,
                    "url": job_url,
                    "employer_name": _clean(employer),
                    "location": _clean(lines[2]) if len(lines) > 2 else "",
                    "description_text": "",
                })
            next_link = page_obj.query_selector("a[title='Next Page'], a:has-text('Next')")
            if not next_link:
                break
            throttle(base, 2)
            try:
                next_link.click()
                page_obj.wait_for_timeout(2000)
            except Exception:
                break
        if not jobs:
            return [], "no_listings_found"
        return jobs, None
    except Exception as error:
        log.warning("higheredjobs_failed", error=str(error))
        return [], "no_listings_found"


def write_snapshot(radar_path: Path, snapshot: dict) -> Path:
    out_dir = radar_path / "radar" / "data" / "aggregated"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{snapshot['source']}.json"
    out_path.write_text(json.dumps(snapshot, indent=2) + "\n", "utf-8")
    return out_path
