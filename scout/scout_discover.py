#!/usr/bin/env python
"""ATS discovery crawl: visit each cap-exempt employer's website, find the
careers page, and harvest ATS links (Workday tenants, Greenhouse/Lever slugs,
iCIMS/Taleo/PageUp/PeopleAdmin/... hosts). The census this produces decides
which employers get wired into the radar and which adapter to build next.

Checkpointed and resumable: results persist after every batch; reruns skip
anything already crawled (--recrawl-days N re-does stale entries).

SHARDING is how this finishes. One process crawls one site at a time — the
work is network-bound, so the machine barely matters and the loop was the
whole cost: ~15s a site, ~15 hours for the 3,534 institutions still uncrawled,
which is more than a GitHub job's 6h cap and why the backlog never cleared.
--shard i/N splits the queue N ways; run the shards as parallel processes
locally or as a matrix of runners in CI and the wall clock divides by N.

Shards interleave (index % N) rather than taking contiguous blocks. The queue
is sorted by sponsorship evidence, so contiguous blocks would hand shard 0
every research university and the last shard every community college — same
count, wildly different page weights, and the run is only as fast as its
slowest shard.

Usage:
  python scout/scout_discover.py --limit 50
  python scout/scout_discover.py --all                        # full sweep, resumable
  python scout/scout_discover.py --min-evidence 1             # only USCIS/DOL history
  python scout/scout_discover.py --all --shard 0/8 --out a.json   # one of 8 workers
"""
from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import time
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
# Sites between checkpoints. Small enough that a killed run loses minutes,
# large enough that serializing the result set isn't most of the work.
SAVE_EVERY = 25
PAGE_TIMEOUT_MS = 25000
SETTLE_MS = 1500
# Careers-page candidates to follow per site. find_careers_links ranks them, so
# the real one is near the front; the tail is footer links and duplicates that
# cost a full navigation each to rule out.
MAX_CAREERS_LINKS = 4
# Hard wall-clock ceiling per site. Bounds the queue: 3,541 sites can now be
# costed honestly instead of hostage to whichever homepage links to forty
# things called "jobs".
SITE_BUDGET_S = 60

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
    careers_links = find_careers_links(page)[:MAX_CAREERS_LINKS]

    signature_fallback = []
    deadline = time.monotonic() + SITE_BUDGET_S
    for link in careers_links:
        if ats:
            break
        # Two independent bounds, because one site must never own a worker.
        # The link list was unbounded: find_careers_links returns every anchor
        # matching /careers|jobs|employment|.../, which on a large university
        # homepage is dozens, and each one costs a 25s navigation plus two
        # nested hops — measured at 10+ minutes on a single site, against a
        # 15s average. The slice above caps the count; this caps the clock,
        # since a handful of very slow pages costs the same as many quick ones.
        if time.monotonic() > deadline:
            result["status"] = "budget_exceeded"
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
                    # The deadline has to bind HERE too, not just between outer
                    # iterations. Checked only at the top of the outer loop, a
                    # budget of 60s still permitted a full nested pass to start
                    # at 59s and run for another two minutes — so the ceiling
                    # was really budget + one iteration, and two sites took
                    # eight minutes with the cap supposedly in force.
                    if time.monotonic() > deadline:
                        result["status"] = "budget_exceeded"
                        break
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
    parser.add_argument("--shard", default=None, metavar="I/N",
                        help="crawl only shard I of N (0-indexed), interleaved")
    parser.add_argument("--out", default=None, metavar="PATH",
                        help="write results here instead of ats-discovery.json "
                             "(a shard writes ONLY what it crawled; merge with "
                             "radar/scripts/merge-discovery.js)")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what this shard would crawl, then exit — "
                             "how you size a matrix before spending runner hours")
    args = parser.parse_args()

    shard_index, shard_count = 0, 1
    if args.shard:
        try:
            shard_index, shard_count = (int(part) for part in args.shard.split("/", 1))
        except ValueError:
            parser.error("--shard must look like I/N, e.g. 0/8")
        if not 0 <= shard_index < shard_count:
            parser.error(f"--shard {args.shard}: need 0 <= I < N")

    out_path = Path(args.out) if args.out else OUTPUT_PATH

    directory = json.loads(DIRECTORY_PATH.read_text("utf-8"))["entries"]

    # Prior results decide what to skip. Always read the shared file for that,
    # even when writing elsewhere — otherwise a sharded run recrawls the 2,430
    # sites already done.
    prior_results = {}
    if OUTPUT_PATH.exists():
        prior_results = json.loads(OUTPUT_PATH.read_text("utf-8")).get("employers", {})

    # What this process will write. A shard writes only its own crawl so the
    # merge is a union of disjoint sets and two shards can never clobber each
    # other's work by round-tripping a stale copy of the shared file.
    results = {} if args.out else prior_results

    def evidence(entry):
        return (entry.get("uscis_approvals_3y") or 0) + 2 * (entry.get("dol_certified_3y") or 0)

    cutoff = datetime.now(timezone.utc).timestamp() - args.recrawl_days * 86400
    pending = []
    for key, entry in directory.items():
        if not entry.get("website"):
            continue
        if evidence(entry) < args.min_evidence:
            continue
        prior = prior_results.get(key)
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

    # Slice AFTER --limit so `--limit 800 --shard 0/8` means "100 sites from the
    # first 800", not "the first 100 of shard 0" — the cap is on total work.
    total_pending = len(pending)
    if shard_count > 1:
        pending = [pair for index, pair in enumerate(pending) if index % shard_count == shard_index]

    log.info("discovery_start", pending=len(pending), of_queue=total_pending,
             shard=f"{shard_index}/{shard_count}", already_crawled=len(prior_results),
             out=out_path.name)

    if args.dry_run:
        # ~15s a site is the measured average including page timeouts. Printed
        # as an estimate so a matrix can be sized against the 6h job cap rather
        # than discovered to be too small five hours in.
        eta_h = len(pending) * 15 / 3600
        log.info("dry_run", would_crawl=len(pending), est_hours=round(eta_h, 1),
                 sample=[entry["name"][:40] for _, entry in pending[:3]])
        return 0

    # Nothing to do — don't pay 20s of chromium startup to discover that.
    if not pending:
        log.info("discovery_done", crawled=0, note="queue empty for this shard")
        return 0

    def save():
        # Written to a temp file and moved into place: a run cancelled at the
        # 6h cap used to be able to catch this mid-write and leave truncated
        # JSON, which reads as "no discovery data" on the next run.
        payload = json.dumps({
            "schema_version": SCHEMA_VERSION,
            "generated_at": now_iso(),
            "shard": f"{shard_index}/{shard_count}" if shard_count > 1 else None,
            "employers": results,
        }, indent=1) + "\n"
        tmp = out_path.with_suffix(out_path.suffix + ".tmp")
        tmp.write_text(payload, "utf-8")
        tmp.replace(out_path)

    from playwright.sync_api import sync_playwright

    # A run that hits the CI timeout is cancelled, not finished. Actions sends
    # SIGTERM, which by default kills the process outright and would take the
    # since-last-checkpoint work with it; turning it into KeyboardInterrupt
    # lets the finally below write what we have. This is the same reasoning as
    # the workflow's `if: always()` on its commit step — hours of crawl are
    # worth saving however the run ended.
    def on_terminate(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")

    def on_site_timeout(signum, frame):
        raise TimeoutError(f"site exceeded {SITE_BUDGET_S + 30}s")

    signal.signal(signal.SIGTERM, on_terminate)
    signal.signal(signal.SIGALRM, on_site_timeout)

    interrupted = None
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA)
        # page.content() and eval_on_selector_all carry no explicit timeout, so
        # they were silently taking playwright's 30s default — longer than the
        # navigation cap they follow. One ceiling for every operation.
        context.set_default_timeout(PAGE_TIMEOUT_MS)
        page = context.new_page()
        try:
            for index, (key, entry) in enumerate(pending, 1):
                # One pathological page must never kill a 900-employer sweep
                try:
                    # SIGALRM is the bound that actually holds. Cooperative
                    # deadline checks only fire between navigations, and
                    # playwright's own timeouts turned out not to cover
                    # everything: one homepage (University of New Hampshire)
                    # sat for 10+ minutes against a 25s navigation cap and a
                    # 60s site budget, both nominally in force. An alarm
                    # interrupts wherever the process actually is, so per-site
                    # cost has a ceiling no single site can argue with.
                    signal.alarm(SITE_BUDGET_S + 30)
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
                finally:
                    signal.alarm(0)  # disarm before the bookkeeping below
                results[key] = result
                providers = ",".join(sorted({a["provider"] for a in result["ats"]})) or "-"
                log.info("crawled", n=f"{index}/{len(pending)}", name=entry["name"][:40],
                         status=result["status"], ats=providers)
                # Checkpoint every 25 rather than every site. This used to
                # re-serialize the whole result set once per crawl — at a few
                # thousand entries that is megabytes of JSON per 15s of work,
                # and it only exists so a cancelled run keeps its progress. 25
                # sites is ~6 minutes of loss in the worst case, against a run
                # measured in hours.
                if index % SAVE_EVERY == 0:
                    save()
                # A crashed page poisons subsequent navigations; recycle it
                if index % 50 == 0:
                    page.close()
                    page = context.new_page()
        except KeyboardInterrupt as stop:
            interrupted = stop
        finally:
            # Runs on the timeout kill too — see the SIGTERM handler above.
            save()
            browser.close()

    if interrupted is not None:
        log.warning("discovery_interrupted", crawled=len(results), reason=str(interrupted))
        return 130

    hits = sum(1 for r in results.values() if r.get("ats"))
    log.info("discovery_done", crawled=len(results), with_ats=hits)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
