import sys
import types

import radar_scout.jobs_scout as jobs_scout
from radar_scout.jobs_scout import (
    JobsScoutTarget,
    build_snapshot,
    filter_job_links,
    find_board_links,
    is_research_relevant_title,
    looks_like_bot_wall,
    looks_like_job_posting,
    registrable_domain,
)


def test_research_relevant_titles():
    assert is_research_relevant_title("Senior Research Scientist")
    assert is_research_relevant_title("Postdoctoral Fellow, Immunology")
    assert is_research_relevant_title("Machine Learning Engineer")
    assert not is_research_relevant_title("Parking Attendant")
    assert not is_research_relevant_title("Gift Shop Associate")
    # employer research_areas widen the filter
    assert is_research_relevant_title("Neuroscience Program Manager", ["neuroscience"])


def test_registrable_domain():
    assert registrable_domain("careers.fredhutch.org") == "fredhutch.org"
    assert registrable_domain("fredhutch.org") == "fredhutch.org"


def test_filter_job_links_keeps_only_job_detail_shapes():
    base = "https://www.fredhutch.org/en/about/careers.html"
    pairs = [
        ("/en/jobs/12345", "Research Technician II"),           # relative, id-bearing job path
        ("https://careers.fredhutch.org/postings/9", "Apply"),  # subdomain, posting id
        ("https://evil.example.com/jobs/1", "Research Scientist"),  # foreign domain
        ("https://www.fredhutch.org/en/news/story.html", "Our news"),
        # research-flavored anchor text must NOT qualify a non-job URL:
        ("https://www.fredhutch.org/en/research/research-areas.html", "Research Areas"),
        ("https://www.fredhutch.org/giving", "Postdoctoral Fellowships"),
        ("mailto:jobs@fredhutch.org", "Email us"),
        (None, "broken"),
        ("/en/jobs/12345", "Duplicate of first"),
    ]
    links = filter_job_links(pairs, base)
    urls = [link["url"] for link in links]
    assert urls == [
        "https://www.fredhutch.org/en/jobs/12345",
        "https://careers.fredhutch.org/postings/9",
    ]


def test_filter_job_links_allows_known_ats_domains():
    base = "https://www.stjude.org/jobs.html"
    pairs = [("https://stjude.wd1.myworkdayjobs.com/External/job/Memphis/Scientist_R1", "Scientist")]
    links = filter_job_links(pairs, base)
    assert len(links) == 1


def test_find_board_links():
    base = "https://www.fredhutch.org/en/about/careers.html"
    pairs = [
        ("/en/about/careers/job-openings/staff-job-openings.html", "Staff job openings"),
        ("https://careers.fredhutch.org/search", "Search jobs"),
        ("/en/research/research-areas.html", "Research Areas"),   # not a board
        ("/en/jobs/12345", "Research Technician II"),             # detail, not a board
    ]
    boards = [link["url"] for link in find_board_links(pairs, base)]
    assert "https://www.fredhutch.org/en/about/careers/job-openings/staff-job-openings.html" in boards
    assert "https://careers.fredhutch.org/search" in boards
    assert all("research-areas" not in url for url in boards)
    assert all("/en/jobs/12345" not in url for url in boards)


def test_looks_like_job_posting():
    posting = "Research Technician II. Responsibilities include assays. Qualifications: BS. Full time. Apply now."
    info_page = "Our researchers study cancer across many research areas including genomics and immunology."
    assert looks_like_job_posting(posting)
    assert not looks_like_job_posting(info_page)
    assert not looks_like_job_posting("")


def test_bot_wall_detection():
    assert looks_like_bot_wall("Attention Required! | Cloudflare", "checking your browser")
    assert looks_like_bot_wall("", "Please verify you are a human to continue")
    assert not looks_like_bot_wall("Careers at Fred Hutch", "Search open positions")


def test_build_snapshot_schema():
    snapshot = build_snapshot("fred-hutch", "https://example.org/careers", [], "bot_wall")
    assert snapshot["schema_version"] == 1
    assert snapshot["employer_id"] == "fred-hutch"
    assert snapshot["jobs"] == []
    assert snapshot["skipped_reason"] == "bot_wall"
    assert snapshot["scouted_at"].endswith("Z")


def test_icims_frame_error_is_reported():
    class Link:
        def get_attribute(self, _name):
            return "https://example.icims.com/jobs/1/research/job"

        def inner_text(self):
            return "Research role"

    class GoodFrame:
        def query_selector_all(self, _selector):
            return [Link()]

    class BadFrame:
        def query_selector_all(self, _selector):
            raise RuntimeError("detached frame")

    links, had_error = jobs_scout._frame_links(
        types.SimpleNamespace(frames=[GoodFrame(), BadFrame()])
    )
    assert len(links) == 1
    assert had_error is True


def test_partial_detail_failure_is_non_authoritative(monkeypatch):
    class Element:
        def __init__(self, href=None, text=""):
            self.href = href
            self.text = text

        def get_attribute(self, _name):
            return self.href

        def inner_text(self):
            return self.text

    class Response:
        status = 200

    class Page:
        def __init__(self):
            self.url = ""

        def goto(self, url, **_kwargs):
            if url.endswith("/jobs/2"):
                raise RuntimeError("transient detail failure")
            self.url = url
            return Response()

        def inner_text(self, _selector):
            if "/jobs/" in self.url:
                return "Research role. Responsibilities. Qualifications. Apply now. Job ID 1."
            return "Careers"

        def title(self):
            return "Research Scientist"

        def query_selector_all(self, _selector):
            if self.url.endswith("/careers"):
                return [
                    Element("/jobs/1", "Research Scientist"),
                    Element("/jobs/2", "Research Associate"),
                ]
            return []

        def query_selector(self, selector):
            return Element(text="Research Scientist") if selector == "h1" else None

        def content(self):
            return "<main>Research role. Apply now.</main>"

    page = Page()

    class Browser:
        def new_context(self, **_kwargs):
            return types.SimpleNamespace(new_page=lambda: page)

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
    monkeypatch.setattr(jobs_scout, "robots_allows", lambda _url: True)
    monkeypatch.setattr(jobs_scout, "throttle", lambda *_args: None)

    snapshot = jobs_scout.scout_employer(
        JobsScoutTarget("example", "https://careers.example.org/careers"),
        budget=5,
    )

    assert len(snapshot["jobs"]) == 1
    assert snapshot["skipped_reason"] == "detail_fetch_failed"
