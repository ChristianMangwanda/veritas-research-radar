#!/usr/bin/env python
"""Run the aggregator firehose: scrape research-job boards, write snapshots to
radar/data/aggregated/, then (optionally) run the Node importer that applies
the cap-exempt filter.

Usage:
  python scout/scout_aggregators.py --all [--details 150] [--max-pages 15] [--import]
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
    load_description_cache,
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
    parser.add_argument("--details", type=int, default=150, help="description fetches per source (cap-exempt-matched jobs only); the description cache carries results forward so raising this backfills sponsorship text over a few runs")
    parser.add_argument("--import", dest="run_import", action="store_true")
    args = parser.parse_args()

    sources = ALL_SOURCES if (args.all or not args.source) else args.source
    directory = CapExemptDirectory.load(RADAR_PATH)
    if directory is None:
        log.warning("no_directory", hint="run npm run radar:enrich first; detail fetches will be skipped")
    description_cache = load_description_cache(RADAR_PATH)
    if description_cache:
        log.info("description_cache_loaded", urls=len(description_cache))

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA)
        page = context.new_page()
        failed_sources = []
        output_paths = []
        for source_name in sources:
            source_url = (MADGEX_SOURCES[source_name].list_url.format(page=1)
                          if source_name in MADGEX_SOURCES
                          else "https://www.higheredjobs.com")
            try:
                if source_name in MADGEX_SOURCES:
                    source = MADGEX_SOURCES[source_name]
                    jobs, skipped = scrape_madgex(source, page, max_pages=args.max_pages)
                    if jobs and directory and args.details > 0:
                        fetched = fetch_details(jobs, directory, page, cap=args.details, cache=description_cache)
                        log.info("details_done", source=source_name, fetched=fetched)
                    snapshot = build_snapshot(source_name, source_url, jobs, skipped)
                elif source_name == "higheredjobs":
                    jobs, skipped = scrape_higheredjobs(page, max_pages=args.max_pages or 10)
                    snapshot = build_snapshot("higheredjobs", source_url, jobs, skipped)
                else:
                    continue
            except Exception as error:
                # One parser failure must not discard safe snapshots from the
                # other independent sources in this run.
                log.error("source_crashed", source=source_name, error=str(error))
                snapshot = build_snapshot(source_name, source_url, [], "source_failed")
            out = write_snapshot(RADAR_PATH, snapshot)
            output_paths.append(out)
            if snapshot["skipped_reason"]:
                failed_sources.append(f"{source_name}: {snapshot['skipped_reason']}")
            log.info("snapshot_written", source=source_name, jobs=len(snapshot["jobs"]),
                     skipped_reason=snapshot["skipped_reason"], path=str(out))
        browser.close()

    import_failed = False
    if args.run_import:
        result = subprocess.run(
            ["npm", "run", "radar:import-aggregated", "--", *map(str, output_paths)],
            cwd=RADAR_PATH,
            check=False,
        )
        import_failed = result.returncode != 0
    if failed_sources:
        log.error("non_authoritative_sources", sources=failed_sources)
    return 1 if failed_sources or import_failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
