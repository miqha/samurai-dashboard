#!/usr/bin/env python3
"""Polite, shared request pacing for the public Rating CHGK API.

All threads in a script share one limiter. A 429 pauses every caller before a
bounded retry; Retry-After is respected as seconds or an HTTP date. There are no
proxies, alternate hosts, credentials, or attempts to bypass rate limits.
"""

from datetime import timezone
from email.utils import parsedate_to_datetime
import math
import io
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from refresh_http import read_payload


MIN_INTERVAL_SECONDS = 1.25
DEFAULT_RETRY_AFTER_SECONDS = 30.0
MAX_ATTEMPTS = 4


def retry_after_seconds(value, *, wall_time=None):
    """Interpret Retry-After without shortening a valid upstream cooldown."""
    value = str(value or "").strip()
    try:
        seconds = float(value)
        if math.isfinite(seconds) and seconds >= 0:
            return seconds
    except (ValueError, TypeError):
        pass
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return max(0.0, date.timestamp() - (time.time() if wall_time is None else wall_time))
    except (ValueError, TypeError, OverflowError):
        return DEFAULT_RETRY_AFTER_SECONDS


class RatingHTTP:
    """One process-wide pacer, with injectable clocks for network-free checks."""

    def __init__(self, *, interval=MIN_INTERVAL_SECONDS, opener=None,
                 monotonic=None, sleep=None, wall_time=None):
        self.interval = interval
        self.opener = opener
        self.monotonic = monotonic or time.monotonic
        self.sleep = sleep or time.sleep
        self.wall_time = wall_time or time.time
        self.lock = threading.Lock()
        self.next_start = float("-inf")
        self.cooldown_until = float("-inf")

    def _wait_turn(self):
        while True:
            with self.lock:
                current = self.monotonic()
                delay = max(self.next_start, self.cooldown_until) - current
                if delay <= 0:
                    self.next_start = current + self.interval
                    return
            # Recheck after waking: another thread may have received a 429 while
            # we slept, extending the cooldown for all subsequent starts.
            self.sleep(delay)

    def open(self, request, timeout=75, attempts=MAX_ATTEMPTS):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or parsed.hostname != "api.rating.chgk.info"
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443)):
            raise ValueError("The Rating HTTP limiter only accepts the public HTTPS Rating API")
        if type(attempts) is not int or not 1 <= attempts <= MAX_ATTEMPTS:
            raise ValueError("attempts must be between 1 and 4")
        if isinstance(request, str):
            request = Request(request)
        if hasattr(request, "add_header"):
            request.add_header("Accept-Encoding", "gzip")
        for attempt in range(attempts):
            self._wait_turn()
            try:
                response = (self.opener or urlopen)(request, timeout=timeout)
                headers = getattr(response, "headers", {}) or {}
                encoding = headers.get("Content-Encoding", headers.get("content-encoding", ""))
                if encoding.lower() != "gzip":
                    return response
                try:
                    payload = read_payload(response, 40_000_000)
                    decoded = io.BytesIO(payload)
                    decoded.headers = headers
                    decoded.status = getattr(response, "status", 200)
                    return decoded
                finally:
                    response.close()
            except HTTPError as error:
                if error.code != 429:
                    raise
                header = error.headers.get("Retry-After") if error.headers is not None else None
                cooldown = max(retry_after_seconds(header, wall_time=self.wall_time()),
                               DEFAULT_RETRY_AFTER_SECONDS * 2 ** attempt)
                with self.lock:
                    self.cooldown_until = max(self.cooldown_until, self.monotonic() + cooldown)
                if attempt + 1 >= attempts:
                    raise
                error.close()
        raise AssertionError("Unreachable retry state")


_RATING = RatingHTTP()


def paced_urlopen(request, timeout=75, attempts=MAX_ATTEMPTS):
    """Like urlopen for Rating requests; all calls share pacing and cooldown."""
    return _RATING.open(request, timeout=timeout, attempts=attempts)
