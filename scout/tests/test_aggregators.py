"""Tests for the aggregator description cache and name normalization parity."""
import json
import sys
import types

import scout_aggregators
from radar_scout import aggregators
from radar_scout.aggregators import (
    load_description_cache,
    normalize_name,
    prefill_descriptions,
    token_key,
)


def test_prefill_reuses_cached_descriptions():
    jobs = [
        {"url": "https://x.test/a", "description_text": ""},
        {"url": "https://x.test/b", "description_text": "already here"},
        {"url": "https://x.test/c", "description_text": ""},
    ]
    cache = {"https://x.test/a": "cached text", "https://x.test/b": "stale"}
    reused = prefill_descriptions(jobs, cache)
    assert reused == 1
    assert jobs[0]["description_text"] == "cached text"
    # An existing description is never overwritten by the cache
    assert jobs[1]["description_text"] == "already here"
    assert jobs[2]["description_text"] == ""


def test_prefill_handles_missing_cache():
    jobs = [{"url": "https://x.test/a", "description_text": ""}]
    assert prefill_descriptions(jobs, None) == 0
    assert prefill_descriptions(jobs, {}) == 0


def test_load_description_cache(tmp_path):
    data_dir = tmp_path / "radar" / "data"
    data_dir.mkdir(parents=True)
    store = {
        "jobs": [
            {"url": "https://x.test/a", "description_text": "kept"},
            {"url": "https://x.test/b", "description_text": "  "},
            {"url": None, "description_text": "no url"},
        ]
    }
    (data_dir / "aggregated-jobs.json").write_text(json.dumps(store))
    cache = load_description_cache(tmp_path)
    assert cache == {"https://x.test/a": "kept"}
    # Missing store -> empty cache, no crash
    assert load_description_cache(tmp_path / "nowhere") == {}


def test_name_normalization_mirrors_node_resolver():
    # These assertions pin the invariant that the Python normalizer matches
    # radar/scripts/lib/entity-resolution.js (same suffixes, same stopwords)
    assert normalize_name("The Broad Institute, Inc.") == "BROAD INSTITUTE"
    assert normalize_name("Johns Hopkins University") == "JOHNS HOPKINS UNIVERSITY"
    assert token_key("University of Chicago") == "CHICAGO UNIVERSITY"
    assert token_key("The Scripps Research Institute, Inc.") == "INSTITUTE RESEARCH SCRIPPS"


class _TextElement:
    def __init__(self, text, href=None):
        self.text = text
        self.href = href

    def inner_text(self):
        return self.text

    def get_attribute(self, name):
        return self.href if name == "href" else None


class _Card:
    def query_selector(self, selector):
        if "header" in selector:
            return _TextElement("Research Scientist", "/job/1")
        if "recruiter" in selector:
            return _TextElement("Yale University")
        if "location" in selector:
            return _TextElement("New Haven, CT")
        return None


class _FailsOnSecondPage:
    def __init__(self):
        self.pages = 0

    def goto(self, *_args, **_kwargs):
        self.pages += 1
        if self.pages == 2:
            raise RuntimeError("navigation failed")

    def wait_for_timeout(self, _milliseconds):
        return None

    def query_selector_all(self, _selector):
        return [_Card()]


class _BadCard:
    def query_selector(self, _selector):
        return None


class _UnparseableSecondPage:
    def __init__(self):
        self.pages = 0

    def goto(self, *_args, **_kwargs):
        self.pages += 1

    def wait_for_timeout(self, _milliseconds):
        return None

    def query_selector_all(self, _selector):
        return [_Card()] if self.pages == 1 else [_BadCard()]


def test_madgex_partial_navigation_is_not_authoritative(monkeypatch):
    monkeypatch.setattr(aggregators, "robots_advisory", lambda _url: True)
    monkeypatch.setattr(aggregators, "throttle", lambda *_args: None)
    source = aggregators.MADGEX_SOURCES["nature-careers"]
    jobs, skipped = aggregators.scrape_madgex(source, _FailsOnSecondPage(), max_pages=2)
    assert len(jobs) == 1
    assert skipped == "list_page_2_failed"


def test_madgex_pagination_ceiling_is_not_authoritative(monkeypatch):
    monkeypatch.setattr(aggregators, "robots_advisory", lambda _url: True)
    monkeypatch.setattr(aggregators, "throttle", lambda *_args: None)
    source = aggregators.MADGEX_SOURCES["nature-careers"]
    page = _FailsOnSecondPage()
    jobs, skipped = aggregators.scrape_madgex(source, page, max_pages=1)
    assert len(jobs) == 1
    assert skipped == "pagination_limit_reached"


def test_madgex_later_parser_failure_is_not_a_clean_end(monkeypatch):
    monkeypatch.setattr(aggregators, "robots_advisory", lambda _url: True)
    monkeypatch.setattr(aggregators, "throttle", lambda *_args: None)
    source = aggregators.MADGEX_SOURCES["nature-careers"]
    jobs, skipped = aggregators.scrape_madgex(source, _UnparseableSecondPage(), max_pages=3)
    assert len(jobs) == 1
    assert skipped == "no_parseable_listings_page_2"


def test_source_crash_keeps_other_snapshots_importable(monkeypatch, tmp_path):
    class Browser:
        def new_context(self, **_kwargs):
            return types.SimpleNamespace(new_page=lambda: object())

        def close(self):
            pass

    class Playwright:
        chromium = types.SimpleNamespace(launch=lambda **_kwargs: Browser())

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = lambda: Playwright()
    playwright = types.ModuleType("playwright")
    playwright.sync_api = sync_api
    monkeypatch.setitem(sys.modules, "playwright", playwright)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    monkeypatch.setattr(scout_aggregators, "RADAR_PATH", tmp_path)
    monkeypatch.setattr(scout_aggregators, "configure_logging", lambda: None)
    monkeypatch.setattr(scout_aggregators.CapExemptDirectory, "load", classmethod(lambda _cls, _path: None))
    monkeypatch.setattr(scout_aggregators, "load_description_cache", lambda _path: {})

    def scrape(source, _page, max_pages=None):
        if source.name == "nature-careers":
            raise RuntimeError("selector parser crashed")
        return ([{
            "title": "Research Scientist",
            "url": "https://jobs.example.org/1",
            "employer_name": "Yale University",
            "location": "New Haven, CT",
            "description_text": "",
        }], None)

    monkeypatch.setattr(scout_aggregators, "scrape_madgex", scrape)
    imported = {}

    def run(command, **_kwargs):
        imported["command"] = command
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(scout_aggregators.subprocess, "run", run)
    monkeypatch.setattr(sys, "argv", [
        "scout_aggregators.py",
        "--source", "nature-careers",
        "--source", "science-careers",
        "--import",
    ])

    assert scout_aggregators.main() == 1
    failed = json.loads((tmp_path / "radar/data/aggregated/nature-careers.json").read_text())
    successful = json.loads((tmp_path / "radar/data/aggregated/science-careers.json").read_text())
    assert failed["skipped_reason"] == "source_failed"
    assert successful["skipped_reason"] is None
    assert set(imported["command"][-2:]) == {
        str(tmp_path / "radar/data/aggregated/nature-careers.json"),
        str(tmp_path / "radar/data/aggregated/science-careers.json"),
    }
