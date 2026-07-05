#!/usr/bin/env python
"""ATS discovery crawl: visit each cap-exempt employer's website, find the
careers page, and harvest ATS links (Workday tenants, Greenhouse/Lever slugs,
iCIMS/Taleo/PageUp/PeopleAdmin/... hosts). The census this produces decides
which employers get wired into the radar and which adapter to build next.

Checkpointed and resumable: results persist to radar/data/ats-discovery.json
after every employer; reruns skip anything already crawled (--recrawl-days N
re-does stale entries). Evidence-bearing employers crawl first.

Usage:
  python scout/scout_discover.py --limit 50
  python scout/scout_discover.py --all              # full sweep, resumable
  python scout/scout_discover.py --min-evidence 1   # only employers with USCIS/DOL history
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from radar_scout.logging_utils import configure_logging, get_logger
from radar_scout.net import UA, throttle

log = get_logger("scout_discover")

RADAR_PATH = Path(__file__).resolve().parents[1]
DIRECTORY_PATH = RADAR_PATH / "radar" / "data" / "cap-exempt-directory.json"
OUTPUT_PATH = RADAR_PATH / "radar" / "data" / "ats-discovery.json"

SCHEMA_VERSION = 1
PAGE_TIMEOUT_MS = 25000
SETTLE_MS = 1500

# Provider patterns with tenant/slug extraction. Matched against raw HTML of
# the careers page (catches hrefs, iframes, and script-injected URLs alike).
ATS_PATTERNS = [
    ("workday", re.compile(r"https?://([a-z0-9-]+)\.wd(\d+)\.myworkdayjobs\.com(?:/(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+))?", re.I)),
    ("greenhouse", re.compile(r"boards\.greenhouse\.io/(?:embed/job_board\?for=)?([a-z0-9_-]+)", re.I)),
    ("greenhouse", re.compile(r"job-boards\.greenhouse\.io/([a-z0-9_-]+)", re.I)),
    ("lever", re.compile(r"jobs\.lever\.co/([a-z0-9-]+)", re.I)),
    ("ashby", re.compile(r"jobs\.ashbyhq\.com/([a-z0-9-]+)", re.I)),
    ("smartrecruiters", re.compile(r"(?:careers|jobs)\.smartrecruiters\.com/([A-Za-z0-9]+)", re.I)),
    ("icims", re.compile(r"https?://(?:careers-)?([a-z0-9-]+)\.icims\.com", re.I)),
    ("taleo", re.compile(r"https?://([a-z0-9-]+)\.taleo\.net", re.I)),
    ("pageup", re.compile(r"https?://([a-z0-9-]+)\.(?:dc\d\.)?pageuppeople\.com", re.I)),
    ("peopleadmin", re.compile(r"https?://([a-z0-9-]+)\.peopleadmin\.com", re.I)),
    ("interfolio", re.compile(r"apply\.interfolio\.com/(\d+)?", re.I)),
    ("successfactors", re.compile(r"https?://([a-z0-9-]+)\.successfactors\.(?:com|eu)", re.I)),
    ("csod", re.compile(r"https?://([a-z0-9-]+)\.csod\.com", re.I)),
    ("adp", re.compile(r"workforcenow\.adp\.com[^\"'\s]*(?:cid|client)=([a-f0-9-]+)?", re.I)),
    ("jobvite", re.compile(r"jobs\.jobvite\.com/([a-z0-9-]+)", re.I)),
    ("recruitee", re.compile(r"https?://([a-z0-9-]+)\.recruitee\.com", re.I)),
    ("breezy", re.compile(r"https?://([a-z0-9-]+)\.breezy\.hr", re.I)),
    ("workable", re.compile(r"apply\.workable\.com/([a-z0-9-]+)", re.I)),
    ("governmentjobs", re.compile(r"governmentjobs\.com/careers/([a-z0-9-]+)", re.I)),
    ("paylocity", re.compile(r"recruiting\.paylocity\.com/recruiting/jobs/[A-Za-z]+/([a-f0-9-]+)?", re.I)),
    ("dayforce", re.compile(r"(?:jobs|us\d+)\.dayforcehcm\.com/(?:en-us/)?([a-z0-9_-]+)?", re.I)),
    ("ultipro", re.compile(r"recruiting(?:2)?\.ultipro\.com/([A-Z0-9]+)?", re.I)),
    ("oraclecloud", re.compile(r"https?://([a-z0-9-]+)\.fa\.[a-z0-9-]+\.oraclecloud\.com", re.I)),
]

# Vanity-domain portals (jobs.university.edu) hide the ATS from URL matching,
# but the page HTML betrays the platform (Workday data attributes, PeopleAdmin
# assets, ...). Signatures run on careers/portal pages, never homepages.
CONTENT_SIGNATURES = [
    ("workday", re.compile(r"myworkdayjobs|data-automation-id|/wday/|workdaycdn", re.I)),
    ("peopleadmin", re.compile(r"peopleadmin", re.I)),
    ("interfolio", re.compile(r"interfolio", re.I)),
    ("brassring", re.compile(r"brassring|kenexa", re.I)),
    ("pageup", re.compile(r"pageuppeople", re.I)),
    ("icims", re.compile(r"icims\.com", re.I)),
    ("taleo", re.compile(r"taleo\.net", re.I)),
    ("successfactors", re.compile(r"successfactors\.(?:com|eu)", re.I)),
    ("csod", re.compile(r"csod\.com", re.I)),
]


def signature_hits(html: str, page_url: str) -> list[dict]:
    hits = []
    for provider, pattern in CONTENT_SIGNATURES:
        if pattern.search(html or ""):
            hits.append({"provider": provider, "tenant": None, "url": page_url, "via": "signature"})
    return hits


CAREERS_LINK = re.compile(
    r"careers?|jobs?\b|employment|work-?(?:with|for|at)-?us|join-?(?:us|our)|human-?resources|vacanc",
    re.I)

# Careers links that are actually student/faculty-services pages
CAREERS_EXCLUDE = re.compile(r"career-?(?:services|center|counsel|fair|development)|student|alumni", re.I)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def extract_ats_links(html: str) -> list[dict]:
    found = {}
    for provider, pattern in ATS_PATTERNS:
        for match in pattern.finditer(html or ""):
            tenant = next((g for g in match.groups() if g), None)
            key = (provider, (tenant or "").lower())
            if key not in found:
                record = {"provider": provider, "tenant": tenant, "url": match.group(0)}
                if provider == "workday" and match.lastindex and match.lastindex >= 2:
                    record["workday_dc"] = match.group(2)
                    record["workday_site"] = match.group(3)
                found[key] = record
    return list(found.values())


def find_careers_links(page) -> list[str]:
    """Rank same-page links that look like a jobs/careers destination."""
    # SVG anchors expose href as an SVGAnimatedString object, not a string —
    # normalize in the browser and guard again here
    anchors = page.eval_on_selector_all(
        "a[href]",
        "els => els.map(e => ({href: typeof e.href === 'string' ? e.href : (e.href && e.href.baseVal) || '', text: (e.textContent||'').trim().slice(0,80)}))")
    scored = []
    for anchor in anchors:
        href, text = anchor.get("href", ""), anchor.get("text", "")
        if not isinstance(href, str) or not href.startswith("http"):
            continue
        haystack = f"{href} {text}"
        if not CAREERS_LINK.search(haystack) or CAREERS_EXCLUDE.search(haystack):
            continue
        # Prefer explicit employment words over bare "careers" (career services trap)
        score = 2 if re.search(r"employment|work-?(?:with|for|at)|join|jobs\b", haystack, re.I) else 1
        scored.append((score, href))
    scored.sort(key=lambda pair: -pair[0])
    seen, ordered = set(), []
    for _, href in scored:
        if href not in seen:
            seen.add(href)
            ordered.append(href)
    return ordered[:3]


def collect_page_html(page) -> str:
    """Main frame HTML plus every child frame URL (Workday embeds live there)."""
    parts = [page.content()]
    for frame in page.frames:
        parts.append(frame.url or "")
    return "\n".join(parts)


def discover_employer(page, entry: dict) -> dict:
    result = {
        "name": entry["name"],
        "website": entry["website"],
        "careers_url": None,
        "ats": [],
        "status": "ok",
        "uscis_approvals_3y": entry.get("uscis_approvals_3y", 0),
        "dol_certified_3y": entry.get("dol_certified_3y", 0),
        "crawled_at": now_iso(),
    }
    try:
        throttle(entry["website"], 2)
        page.goto(entry["website"], wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        page.wait_for_timeout(SETTLE_MS)
    except Exception as error:
        result["status"] = f"homepage_error: {type(error).__name__}"
        return result

    # ATS links sometimes sit on the homepage itself
    ats = extract_ats_links(collect_page_html(page))
    careers_links = find_careers_links(page)

    signature_fallback = []
    for link in careers_links:
        if ats:
            break
        try:
            throttle(link, 2)
            page.goto(link, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
            page.wait_for_timeout(SETTLE_MS)
            result["careers_url"] = link
            html = collect_page_html(page)
            ats = extract_ats_links(html)
            if not ats:
                signature_fallback = signature_hits(html, page.url) or signature_fallback
                # One hop deeper: "View open positions" style links
                for nested in find_careers_links(page)[:2]:
                    if nested == link:
                        continue
                    try:
                        throttle(nested, 2)
                        page.goto(nested, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                        page.wait_for_timeout(SETTLE_MS)
                        nested_html = collect_page_html(page)
                        ats = extract_ats_links(nested_html)
                        if ats:
                            result["careers_url"] = nested
                            break
                        signature_fallback = signature_hits(nested_html, page.url) or signature_fallback
                    except Exception:
                        continue
        except Exception:
            continue

    # URL-pattern hits carry tenants and win; signatures identify the platform
    # behind vanity domains (jobs.university.edu) when no tenant URL leaks
    if not ats and signature_fallback:
        ats = signature_fallback

    result["ats"] = ats
    if not ats and not result["careers_url"] and careers_links:
        result["careers_url"] = careers_links[0]
        result["status"] = "careers_unreachable"
    elif not ats and not careers_links:
        result["status"] = "no_careers_link"
    return result


def main() -> int:
    configure_logging()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--min-evidence", type=int, default=0,
                        help="minimum (uscis + 2*dol) evidence score to include")
    parser.add_argument("--recrawl-days", type=int, default=90)
    args = parser.parse_args()

    directory = json.loads(DIRECTORY_PATH.read_text("utf-8"))["entries"]
    results = {}
    if OUTPUT_PATH.exists():
        results = json.loads(OUTPUT_PATH.read_text("utf-8")).get("employers", {})

    def evidence(entry):
        return (entry.get("uscis_approvals_3y") or 0) + 2 * (entry.get("dol_certified_3y") or 0)

    cutoff = datetime.now(timezone.utc).timestamp() - args.recrawl_days * 86400
    pending = []
    for key, entry in directory.items():
        if not entry.get("website"):
            continue
        if evidence(entry) < args.min_evidence:
            continue
        prior = results.get(key)
        if prior:
            try:
                crawled = datetime.fromisoformat(prior["crawled_at"]).timestamp()
                if crawled > cutoff:
                    continue
            except (KeyError, ValueError):
                pass
        pending.append((key, entry))

    pending.sort(key=lambda pair: -evidence(pair[1]))
    if not args.all:
        pending = pending[: args.limit or 25]
    elif args.limit:
        pending = pending[: args.limit]

    log.info("discovery_start", pending=len(pending), already_crawled=len(results))

    def save():
        OUTPUT_PATH.write_text(json.dumps({
            "schema_version": SCHEMA_VERSION,
            "generated_at": now_iso(),
            "employers": results,
        }, indent=1) + "\n", "utf-8")

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA)
        page = context.new_page()
        for index, (key, entry) in enumerate(pending, 1):
            # One pathological page must never kill a 900-employer sweep
            try:
                result = discover_employer(page, entry)
            except Exception as error:
                result = {
                    "name": entry["name"], "website": entry["website"], "careers_url": None,
                    "ats": [], "status": f"crawler_error: {type(error).__name__}",
                    "uscis_approvals_3y": entry.get("uscis_approvals_3y", 0),
                    "dol_certified_3y": entry.get("dol_certified_3y", 0),
                    "crawled_at": now_iso(),
                }
                page.close()
                page = context.new_page()
            results[key] = result
            providers = ",".join(sorted({a["provider"] for a in result["ats"]})) or "-"
            log.info("crawled", n=f"{index}/{len(pending)}", name=entry["name"][:40],
                     status=result["status"], ats=providers)
            save()
            # A crashed page poisons subsequent navigations; recycle it
            if index % 50 == 0:
                page.close()
                page = context.new_page()
        browser.close()

    hits = sum(1 for r in results.values() if r.get("ats"))
    log.info("discovery_done", crawled=len(results), with_ats=hits)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
