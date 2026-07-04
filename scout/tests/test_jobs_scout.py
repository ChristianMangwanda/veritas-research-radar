from radar_scout.jobs_scout import (
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
