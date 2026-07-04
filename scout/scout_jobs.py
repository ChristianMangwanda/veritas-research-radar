#!/usr/bin/env python
"""Scout research job postings for radar registry employers with no ATS feed.

Usage:
  python scout/scout_jobs.py --employer fred-hutch [--employer salk-institute]
  python scout/scout_jobs.py --all
  python scout/scout_jobs.py --employer fred-hutch --import
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import yaml

from radar_scout.jobs_scout import DEFAULT_FETCH_BUDGET, load_targets, scout_employer, write_snapshot
from radar_scout.logging_utils import configure_logging, get_logger

log = get_logger("scout_jobs")

RADAR_PATH = Path(__file__).resolve().parents[1]


def main() -> int:
    configure_logging()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--employer", action="append", default=[], help="employer id (repeatable)")
    parser.add_argument("--all", action="store_true", help="scout every registry employer without an ATS feed")
    parser.add_argument("--budget", type=int, default=DEFAULT_FETCH_BUDGET, help="max page fetches per employer")
    parser.add_argument("--import", dest="run_import", action="store_true", help="run npm run radar:import-scouted afterwards")
    args = parser.parse_args()

    if not args.employer and not args.all:
        parser.error("pass --employer <id> (repeatable) or --all")

    overrides_path = Path(__file__).resolve().parent / "jobs_scrape.yaml"
    overrides = {}
    if overrides_path.exists():
        overrides = yaml.safe_load(overrides_path.read_text("utf-8")) or {}

    targets = load_targets(RADAR_PATH, employer_ids=args.employer or None, overrides=overrides)
    if not targets:
        log.warning("no_targets", requested=args.employer or "all")
        return 1

    for target in targets:
        snapshot = scout_employer(target, budget=args.budget)
        out_path = write_snapshot(RADAR_PATH, snapshot)
        log.info(
            "snapshot_written",
            employer=target.employer_id,
            jobs=len(snapshot["jobs"]),
            skipped_reason=snapshot["skipped_reason"],
            path=str(out_path),
        )

    if args.run_import:
        subprocess.run(["npm", "run", "radar:import-scouted"], cwd=RADAR_PATH, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
