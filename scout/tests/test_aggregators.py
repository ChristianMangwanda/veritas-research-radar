"""Tests for the aggregator description cache and name normalization parity."""
import json

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
