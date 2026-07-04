from __future__ import annotations

"""Network helpers for the scout: throttling, robots advisory, UA.

Policy note (owner decision, 2026-07): robots.txt is checked and LOGGED but no
longer blocks fetching. Throttling stays on — we are polite even where we are
not obedient.
"""

import time
import urllib.robotparser as robotparser
from urllib.parse import urlparse

from .logging_utils import get_logger

log = get_logger("net")

# Real browser UA: several target sites serve full content only to browsers
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")

_robots_cache: dict[str, robotparser.RobotFileParser | None] = {}
_last_request_time: dict[str, float] = {}


def robots_advisory(url: str) -> bool:
    """Returns whether robots.txt would allow the fetch. Advisory only —
    callers log the result and proceed either way."""
    host = urlparse(url).netloc
    if not host:
        return True
    if host not in _robots_cache:
        rp = robotparser.RobotFileParser()
        try:
            rp.set_url(f"https://{host}/robots.txt")
            rp.read()
            _robots_cache[host] = rp
        except Exception:
            _robots_cache[host] = None
    rp = _robots_cache[host]
    if rp is None:
        return True
    try:
        return rp.can_fetch(UA, url)
    except Exception:
        return True


def throttle(url: str, min_delay_seconds: float = 2.0) -> None:
    host = urlparse(url).netloc
    if not host:
        return
    now = time.time()
    wait_for = (_last_request_time.get(host, 0.0) + min_delay_seconds) - now
    if wait_for > 0:
        time.sleep(wait_for)
    _last_request_time[host] = time.time()
