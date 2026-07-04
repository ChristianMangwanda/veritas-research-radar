#!/usr/bin/env python
"""Run the aggregator firehose: scrape research-job boards, write snapshots to
radar/data/aggregated/, then (optionally) run the Node importer that applies
the cap-exempt filter.

Usage:
  python scout/scout_aggregators.py --all [--details 60] [--max-pages 15] [--import]
  python scout/scout_aggregators.py --source nature-careers --source science-careers
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from radar_scout.aggregators import (
    MADGEX_SOURCES,
    CapExemptDirectory,
    build_snapshot,
    fetch_details,
    scrape_higheredjobs,
    scrape_madgex,
    write_snapshot,
)
from radar_scout.logging_utils import configure_logging, get_logger
from radar_scout.net import UA

log = get_logger("scout_aggregators")

RADAR_PATH = Path(__file__).resolve().parents[1]
ALL_SOURCES = [*MADGEX_SOURCES.keys(), "higheredjobs"]


def main() -> int:
    configure_logging()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", default=[], choices=ALL_SOURCES)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--details", type=int, default=60, help="description fetches per source (cap-exempt-matched jobs only)")
    parser.add_argument("--import", dest="run_import", action="store_true")
    args = parser.parse_args()

    sources = ALL_SOURCES if (args.all or not args.source) else args.source
    directory = CapExemptDirectory.load(RADAR_PATH)
    if directory is None:
        log.warning("no_directory", hint="run npm run radar:enrich first; detail fetches will be skipped")

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA)
        page = context.new_page()
        for source_name in sources:
            if source_name in MADGEX_SOURCES:
                source = MADGEX_SOURCES[source_name]
                jobs = scrape_madgex(source, page, max_pages=args.max_pages)
                skipped = None if jobs else "no_listings_found"
                if jobs and directory and args.details > 0:
                    fetched = fetch_details(jobs, directory, page, cap=args.details)
                    log.info("details_done", source=source_name, fetched=fetched)
                snapshot = build_snapshot(source_name, source.list_url.format(page=1), jobs, skipped)
            elif source_name == "higheredjobs":
                jobs, skipped = scrape_higheredjobs(page, max_pages=args.max_pages or 10)
                snapshot = build_snapshot("higheredjobs", "https://www.higheredjobs.com", jobs, skipped)
            else:
                continue
            out = write_snapshot(RADAR_PATH, snapshot)
            log.info("snapshot_written", source=source_name, jobs=len(snapshot["jobs"]),
                     skipped_reason=snapshot["skipped_reason"], path=str(out))
        browser.close()

    if args.run_import:
        subprocess.run(["npm", "run", "radar:import-aggregated"], cwd=RADAR_PATH, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
