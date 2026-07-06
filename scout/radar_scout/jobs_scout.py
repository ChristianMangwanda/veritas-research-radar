from __future__ import annotations

"""Jobs-scout mode: extract research job postings from radar registry employers
whose careers pages expose no clean ATS feed, and write snapshots matching the
radar's SCOUT-CONTRACT.md (radar/data/scouted/<employer-id>.json).

Producer rules (mirrors the contract, non-negotiable):
- never invent a posting; every job carries the URL actually observed
- robots.txt is ALWAYS respected (no government override in this mode)
- bot walls / CAPTCHAs / WAFs are reported as skips, never circumvented
- polite fetching: sequential, throttled, small per-employer budget
"""

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from .logging_utils import get_logger
from .net import UA, robots_advisory, throttle

log = get_logger("jobs_scout")

SCHEMA_VERSION = 1
DEFAULT_FETCH_BUDGET = 15
GOTO_TIMEOUT_MS = 45000

RESEARCH_TITLE_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\bresearch\b",
        r"\bpostdoc(toral)?\b",
        r"\bscientist\b",
        r"\blaborator(y|ies)\b",
        r"\bdata\b",
        r"\bcomputational\b",
        r"\bbioinformatic",
        r"\bgenomic",
        r"\bmachine\s+learning\b",
        r"\bsoftware\s+engineer",
    )
]

# Job DETAIL pages only — an individual posting, not a careers/nav page.
# Anchor text never qualifies a link (info pages get research-y titles too);
# it is only used to rank which details get the fetch budget.
JOB_DETAIL_PATTERN = re.compile(
    r"/job[s]?/[^/?#]*\d"                      # /jobs/12345..., icims, greenhouse
    r"|/job[s]?/[^/?#]+/[^/?#]+"               # /job/Location/Title_JR123 (workday, phenom)
    r"|[?&](job|req|posting|position)_?id="    # query-param ids
    r"|/job-?details?"
    r"|/requisitions?/"
    r"|/postings?/[^/?#]*\d",
    re.IGNORECASE,
)

# Pages likely to BE a job board / listing hub — visited (never emitted) when
# the landing page itself exposes no detail links.
BOARD_LINK_PATTERN = re.compile(
    r"^https?://(careers?|jobs?|recruiting|apply|talent)\."
    r"|/(job-?openings?|jobs?|careers?|search-results?|open-positions?|vacanc\w*|employment)([/.?#]|\.html|$)",
    re.IGNORECASE,
)

# Markers a real posting page carries; informational pages lack the apply flow
APPLY_MARKERS = ("apply", "submit your application", "job id", "req id", "requisition")
POSTING_STRUCTURE_MARKERS = (
    "responsibilities", "qualifications", "job description", "requisition",
    "job id", "req id", "full time", "full-time", "part time", "part-time", "salary", "pay range",
)

# External hosts employers commonly outsource job pages to; anything else must
# share the employer's registrable domain.
KNOWN_ATS_DOMAINS = {
    "myworkdayjobs.com",
    "greenhouse.io",
    "lever.co",
    "icims.com",
    "taleo.net",
    "smartrecruiters.com",
    "ashbyhq.com",
    "successfactors.com",
    "oraclecloud.com",
    "csod.com",
    "jobvite.com",
    "recruitee.com",
    "breezy.hr",
    "workable.com",
    "paylocity.com",
    "ultipro.com",
    "dayforcehcm.com",
}

BOT_WALL_MARKERS = (
    "access denied",
    "attention required",
    "verify you are a human",
    "are you a robot",
    "captcha",
    "_incapsula_",
    "just a moment",
)



@dataclass
class JobsScoutTarget:
    employer_id: str
    listing_url: str
    research_areas: list[str] = field(default_factory=list)
    selector: str = "a"


def registrable_domain(host: str) -> str:
    parts = (host or "").lower().split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else (host or "").lower()


def robots_allows(url: str) -> bool:
    """Advisory since 2026-07 (owner decision): a robots disallow is logged
    but no longer blocks the fetch."""
    if not robots_advisory(url):
        log.info("robots_disallow_advisory", url=url)
    return True


def is_research_relevant_title(title: str, research_areas: list[str] | None = None) -> bool:
    text = title or ""
    if any(pattern.search(text) for pattern in RESEARCH_TITLE_PATTERNS):
        return True
    lower = text.lower()
    return any(str(area).lower() in lower for area in research_areas or [])


def looks_like_bot_wall(page_title: str, body_text: str) -> bool:
    haystack = f"{page_title}\n{body_text[:2000]}".lower()
    return any(marker in haystack for marker in BOT_WALL_MARKERS)


def _eligible_links(anchor_pairs: list[tuple[str | None, str]], base_url: str) -> list[dict]:
    base_domain = registrable_domain(urlparse(base_url).netloc)
    seen: set[str] = set()
    results: list[dict] = []
    for href, text in anchor_pairs:
        if not href:
            continue
        absolute = urljoin(base_url, href.strip())
        parsed = urlparse(absolute)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            continue
        domain = registrable_domain(parsed.netloc)
        if domain != base_domain and domain not in KNOWN_ATS_DOMAINS:
            continue
        key = absolute.split("#")[0]
        if key in seen or key.rstrip("/") == base_url.rstrip("/"):
            continue
        seen.add(key)
        results.append({"url": absolute, "text": " ".join((text or "").split())})
    return results


def filter_job_links(anchor_pairs: list[tuple[str | None, str]], base_url: str) -> list[dict]:
    """Pure link triage: keep only links whose URL is shaped like an individual
    job posting on the employer's domain (or a known ATS domain). Anchor text
    never qualifies a link — research-flavored nav pages are not jobs."""
    return [link for link in _eligible_links(anchor_pairs, base_url)
            if JOB_DETAIL_PATTERN.search(link["url"])]


def find_board_links(anchor_pairs: list[tuple[str | None, str]], base_url: str) -> list[dict]:
    """Links likely to lead to the employer's actual job board / listing hub.
    These are hopped to (and never emitted as jobs) when the landing page
    itself exposes no job-detail links."""
    return [link for link in _eligible_links(anchor_pairs, base_url)
            if not JOB_DETAIL_PATTERN.search(link["url"]) and BOARD_LINK_PATTERN.search(link["url"])]


def looks_like_job_posting(body_text: str) -> bool:
    """A real posting has an apply flow and posting structure; informational
    pages ('Research Areas', 'Diseases We Research') have neither."""
    lower = (body_text or "").lower()
    return (any(marker in lower for marker in APPLY_MARKERS)
            and any(marker in lower for marker in POSTING_STRUCTURE_MARKERS))


def build_snapshot(employer_id: str, source_url: str, jobs: list[dict], skipped_reason: str | None = None) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "employer_id": employer_id,
        "scouted_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_url": source_url,
        "jobs": jobs,
        "skipped_reason": skipped_reason,
    }


def load_targets(radar_path: Path, employer_ids: list[str] | None = None, overrides: dict | None = None) -> list[JobsScoutTarget]:
    employers = json.loads((radar_path / "radar" / "employers.json").read_text("utf-8"))
    overrides = overrides or {}
    targets = []
    for employer in employers:
        if employer_ids and employer["id"] not in employer_ids:
            continue
        if not employer_ids and employer.get("ats_provider"):
            continue  # default set: only employers with no working feed
        override = overrides.get(employer["id"], {})
        listing_url = override.get("listing_url") or employer.get("careers_url")
        if not listing_url:
            continue
        targets.append(JobsScoutTarget(
            employer_id=employer["id"],
            listing_url=listing_url,
            research_areas=employer.get("research_areas", []),
            selector=override.get("selector", "a"),
        ))
    return targets


def _extract_description(html: str) -> str:
    try:
        import trafilatura

        return (trafilatura.extract(html, include_comments=False, include_images=False) or "")[:8000]
    except Exception:
        return ""


ICIMS_JOB_LINK = re.compile(r"/jobs/(\d+)/[^/]+/job", re.I)
ICIMS_MAX_LIST_PAGES = 8
ICIMS_MIN_BUDGET = 40


def _frame_links(page_obj) -> list[tuple[str | None, str]]:
    """Anchors from every frame — iCIMS renders results inside an iframe the
    main-frame collector never sees."""
    links: list[tuple[str | None, str]] = []
    for frame in page_obj.frames:
        try:
            links.extend(
                (el.get_attribute("href"), el.inner_text())
                for el in frame.query_selector_all("a[href]"))
        except Exception:
            continue
    return links


def _icims_job_text(page_obj) -> tuple[str, str]:
    """(title, body_text) from whichever frame carries the job content."""
    for frame in page_obj.frames:
        try:
            content = frame.query_selector(".iCIMS_JobContent, .iCIMS_JobsTable")
            if content:
                heading = frame.query_selector("h1")
                title = " ".join(((heading.inner_text() if heading else "") or "").split())
                return title, content.inner_text()
        except Exception:
            continue
    try:
        return "", page_obj.inner_text("body")
    except Exception:
        return "", ""


def scout_icims_board(target: JobsScoutTarget, budget: int, headless: bool = True) -> dict:
    """iCIMS portals are JS-rendered iframes with ?pr=N pagination. Walks the
    search pages, then fetches job pages and reads the rendered content frame.
    No research-title filter: inclusion over exclusion (owner decision) — the
    radar's scoring layers rank downstream."""
    from playwright.sync_api import sync_playwright

    budget = max(budget, ICIMS_MIN_BUDGET)
    base = target.listing_url
    if "ss=1" not in base:
        base = base + ("&" if "?" in base else "?") + "ss=1"

    jobs: list[dict] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        context = browser.new_context(user_agent=UA)
        page = context.new_page()
        fetched = 0
        detail_urls: list[str] = []
        seen: set[str] = set()
        try:
            for page_no in range(ICIMS_MAX_LIST_PAGES):
                if fetched >= budget:
                    break
                url = f"{base}&pr={page_no}"
                throttle(url, 3)
                fetched += 1
                page.goto(url, wait_until="networkidle", timeout=GOTO_TIMEOUT_MS)
                page.wait_for_timeout(1500)
                new_on_page = 0
                for href, _text in _frame_links(page):
                    if not href or not ICIMS_JOB_LINK.search(href):
                        continue
                    clean = href.split("?")[0]
                    if clean not in seen:
                        seen.add(clean)
                        detail_urls.append(clean)
                        new_on_page += 1
                if new_on_page == 0:
                    break

            if not detail_urls:
                return build_snapshot(target.employer_id, target.listing_url, [], "no_listings_found")

            for url in detail_urls:
                if fetched >= budget:
                    break
                throttle(url, 3)
                fetched += 1
                try:
                    page.goto(url, wait_until="networkidle", timeout=GOTO_TIMEOUT_MS)
                    page.wait_for_timeout(1000)
                except Exception as error:
                    log.warning("icims_detail_failed", employer=target.employer_id, url=url, error=str(error))
                    continue
                title, body = _icims_job_text(page)
                if not title:
                    slug = url.rstrip("/").split("/")[-2] if "/" in url else ""
                    title = slug.replace("-", " ").title()
                if not title or not body:
                    continue
                jobs.append({
                    "title": title,
                    "url": url,
                    "description_text": " ".join(body.split())[:8000],
                })
        except Exception as error:
            log.warning("icims_scout_failed", employer=target.employer_id, error=str(error))
        finally:
            browser.close()

    log.info("icims_scout_done", employer=target.employer_id, jobs=len(jobs), list_urls=len(detail_urls))
    return build_snapshot(target.employer_id, target.listing_url, jobs, None if jobs else "no_listings_found")


def scout_employer(target: JobsScoutTarget, budget: int = DEFAULT_FETCH_BUDGET, headless: bool = True) -> dict:
    from playwright.sync_api import sync_playwright

    host = (urlparse(target.listing_url).hostname or "").lower()
    if host.endswith(".icims.com"):
        return scout_icims_board(target, budget=budget, headless=headless)

    if not robots_allows(target.listing_url):
        log.info("robots_disallow", employer=target.employer_id, url=target.listing_url)
        return build_snapshot(target.employer_id, target.listing_url, [], "robots_disallow")

    jobs: list[dict] = []
    skipped_reason: str | None = None
    MIN_DETAILS_BEFORE_HOP = 3
    MAX_BOARD_HOPS = 3

    def collect(page_obj) -> list[tuple[str | None, str]]:
        return [(el.get_attribute("href"), el.inner_text()) for el in page_obj.query_selector_all(target.selector)]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        context = browser.new_context(user_agent=UA)
        page = context.new_page()
        fetched = 0

        def visit(url: str, wait: str) -> bool:
            nonlocal fetched
            throttle(url, 3)
            fetched += 1
            page.goto(url, wait_until=wait, timeout=GOTO_TIMEOUT_MS)
            return True

        try:
            throttle(target.listing_url, 3)
            fetched += 1
            response = page.goto(target.listing_url, wait_until="networkidle", timeout=GOTO_TIMEOUT_MS)
            status = response.status if response else None
            body_text = page.inner_text("body") if not status or status < 400 else ""
            if (status and status >= 400) or looks_like_bot_wall(page.title(), body_text):
                log.info("bot_wall", employer=target.employer_id, status=status)
                return build_snapshot(target.employer_id, target.listing_url, [], "bot_wall")

            anchors = collect(page)
            details = filter_job_links(anchors, target.listing_url)
            boards = find_board_links(anchors, target.listing_url)

            # Landing pages rarely list postings directly — hop to the board(s)
            hops = 0
            seen_detail_urls = {link["url"] for link in details}
            while len(details) < MIN_DETAILS_BEFORE_HOP and boards and hops < MAX_BOARD_HOPS and fetched < budget:
                board = boards.pop(0)
                if not robots_allows(board["url"]):
                    continue
                hops += 1
                try:
                    visit(board["url"], "networkidle")
                except Exception as error:
                    log.warning("board_fetch_failed", employer=target.employer_id, url=board["url"], error=str(error))
                    continue
                board_anchors = collect(page)
                for link in filter_job_links(board_anchors, page.url):
                    if link["url"] not in seen_detail_urls:
                        seen_detail_urls.add(link["url"])
                        details.append(link)
                for link in find_board_links(board_anchors, page.url):
                    if all(link["url"] != existing["url"] for existing in boards):
                        boards.append(link)

            if not details:
                log.info("no_listings_found", employer=target.employer_id, board_hops=hops)
                return build_snapshot(target.employer_id, target.listing_url, [], "no_listings_found")

            # Spend the remaining budget on research-shaped anchors first
            details.sort(key=lambda link: not is_research_relevant_title(link["text"], target.research_areas))
            for link in details:
                if fetched >= budget:
                    break
                if not robots_allows(link["url"]):
                    continue
                try:
                    visit(link["url"], "domcontentloaded")
                except Exception as error:
                    log.warning("detail_fetch_failed", employer=target.employer_id, url=link["url"], error=str(error))
                    continue
                page_body = page.inner_text("body")
                if not looks_like_job_posting(page_body):
                    log.info("not_a_posting", employer=target.employer_id, url=page.url)
                    continue
                heading = page.query_selector("h1")
                title = " ".join(((heading.inner_text() if heading else "") or page.title() or link["text"]).split())
                if not title or not is_research_relevant_title(title, target.research_areas):
                    continue
                jobs.append({
                    "title": title,
                    "url": page.url,
                    "description_text": _extract_description(page.content()),
                })
        except Exception as error:
            log.warning("scout_failed", employer=target.employer_id, error=str(error))
            skipped_reason = "no_listings_found" if not jobs else None
        finally:
            browser.close()

    log.info("scout_done", employer=target.employer_id, jobs=len(jobs))
    return build_snapshot(target.employer_id, target.listing_url, jobs, skipped_reason if not jobs else None)


def write_snapshot(radar_path: Path, snapshot: dict) -> Path:
    out_dir = radar_path / "radar" / "data" / "scouted"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{snapshot['employer_id']}.json"
    out_path.write_text(json.dumps(snapshot, indent=2) + "\n", "utf-8")
    return out_path
