#!/usr/bin/env python3
"""Offline checks for shared Rating pacing and cooperative HTTP 429 retries."""

from datetime import datetime, timezone
from email.utils import format_datetime
import io
import gzip
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import rating_http as http

URL = "https://api.rating.chgk.info/tournaments/101"


class Clock:
    def __init__(self):
        self.value = 0.0
        self.sleeps = []
        self.epoch = datetime(2026, 11, 9, tzinfo=timezone.utc).timestamp()

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.value += seconds

    def wall_time(self):
        return self.epoch + self.value


class RatingHTTPTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.starts = []
        self.responses = []

    def pacer(self, opener):
        return http.RatingHTTP(opener=opener, monotonic=self.clock.monotonic,
                               sleep=self.clock.sleep, wall_time=self.clock.wall_time)

    def success(self, request, timeout=75):
        self.starts.append(self.clock.value)
        response = io.BytesIO(b'{"public":true}')
        self.responses.append(response)
        return response

    def rate_error(self, retry_after=None):
        headers = {} if retry_after is None else {"Retry-After": retry_after}
        return HTTPError(URL, 429, "Too Many Requests", headers, io.BytesIO(b"public 429"))

    def test_every_request_start_is_paced_and_context_manager_behavior_is_preserved(self):
        pacer = self.pacer(self.success)
        request = Request(URL)
        with pacer.open(request, timeout=42) as response:
            self.assertEqual(response.read(), b'{"public":true}')
        with pacer.open(URL) as response:
            self.assertTrue(response.read())
        with pacer.open(URL) as response:
            self.assertTrue(response.read())
        self.assertEqual(self.starts, [0, 1.25, 2.5])
        self.assertTrue(all(response.closed for response in self.responses))

    def test_retry_after_seconds_retries_after_cooldown_and_closes_error_response(self):
        error = self.rate_error("7")
        failed_response = error.fp
        first = True

        def opener(request, timeout=75):
            nonlocal first
            if first:
                first = False
                self.starts.append(self.clock.value)
                raise error
            return self.success(request, timeout)

        with self.pacer(opener).open(URL) as response:
            self.assertTrue(response.read())
        self.assertEqual(self.starts, [0, 30])
        self.assertTrue(failed_response.closed)

    def test_retry_after_http_date_is_respected_without_shortening(self):
        value = format_datetime(datetime.fromtimestamp(self.clock.epoch + 120, timezone.utc), usegmt=True)
        errors = [self.rate_error(value)]

        def opener(request, timeout=75):
            if errors:
                self.starts.append(self.clock.value)
                raise errors.pop()
            return self.success(request, timeout)

        self.pacer(opener).open(URL).close()
        self.assertEqual(self.starts, [0, 120])

    def test_retry_after_seconds_longer_than_backoff_is_not_shortened(self):
        errors = [self.rate_error("180")]

        def opener(request, timeout=75):
            if errors:
                self.starts.append(self.clock.value)
                raise errors.pop()
            return self.success(request, timeout)

        self.pacer(opener).open(URL).close()
        self.assertEqual(self.starts, [0, 180])

    def test_exhaustion_has_four_attempts_and_keeps_cooldown_for_other_callers(self):
        failures, error_bodies = [], []

        def opener(request, timeout=75):
            self.starts.append(self.clock.value)
            error = self.rate_error("1")
            failures.append(error)
            error_bodies.append(error.fp)
            raise error

        pacer = self.pacer(opener)
        with self.assertRaises(HTTPError) as caught:
            pacer.open(URL)
        self.assertEqual(caught.exception.code, 429)
        self.assertEqual(self.starts, [0, 30, 90, 210])
        self.assertEqual(len(failures), 4)
        self.assertTrue(all(body.closed for body in error_bodies[:-1]))
        caught.exception.close()
        pacer.opener = self.success
        pacer.open(URL).close()
        self.assertEqual(self.starts[-1], 450)

    def test_non_429_http_error_and_network_error_are_not_retried(self):
        for error in (HTTPError(URL, 403, "Forbidden", {}, None), URLError("network unavailable")):
            with self.subTest(error=type(error).__name__):
                calls = []

                def failed(request, timeout=75):
                    calls.append(request)
                    raise error

                with self.assertRaises(type(error)):
                    self.pacer(failed).open(URL)
                self.assertEqual(len(calls), 1)

    def test_retry_after_invalid_missing_and_expired_values(self):
        for value in (None, "", "nonsense", "-12", "NaN", "inf"):
            self.assertEqual(http.retry_after_seconds(value, wall_time=self.clock.epoch), 30)
        self.assertEqual(http.retry_after_seconds("0", wall_time=self.clock.epoch), 0)
        expired = format_datetime(datetime.fromtimestamp(self.clock.epoch - 12, timezone.utc), usegmt=True)
        self.assertEqual(http.retry_after_seconds(expired, wall_time=self.clock.epoch), 0)

    def test_only_the_public_rating_https_host_and_bounded_attempts_are_accepted(self):
        pacer = self.pacer(self.success)
        for url in ("https://gotquestions.online/", "http://api.rating.chgk.info/tournaments",
                    "https://api.rating.chgk.info.evil.invalid/tournaments",
                    "https://user:pass@api.rating.chgk.info/tournaments", "https://api.rating.chgk.info:444/"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                pacer.open(url)
        for attempts in (0, 5, True, "4"):
            with self.assertRaises(ValueError):
                pacer.open(URL, attempts=attempts)
        self.assertEqual(self.starts, [])

    def test_exported_function_shares_the_singleton_limiter(self):
        with patch.object(http, "_RATING", self.pacer(self.success)):
            http.paced_urlopen(URL).close()
            http.paced_urlopen(URL).close()
        self.assertEqual(self.starts, [0, 1.25])

    def test_gzip_api_response_keeps_headers_and_closes_network_stream(self):
        source = io.BytesIO(gzip.compress(b'{"public":true}'))
        source.headers = {"Content-Encoding": "gzip", "Date": "Tue, 17 Nov 2026 00:00:00 GMT"}
        source.status = 200

        def opener(request, timeout=75):
            self.assertEqual(request.get_header("Accept-encoding"), "gzip")
            return source

        with self.pacer(opener).open(URL) as response:
            self.assertEqual(response.read(), b'{"public":true}')
            self.assertEqual(response.headers["Date"], source.headers["Date"])
            self.assertEqual(response.status, 200)
        self.assertTrue(source.closed)

    def test_cooldown_is_shared_with_another_thread_already_waiting_to_start(self):
        condition = threading.Condition()
        current = 0.0
        sleeps = []
        started = []
        first_request = True

        def monotonic():
            with condition:
                return current

        def sleep(seconds):
            with condition:
                target = current + seconds
                sleeps.append(target)
                condition.notify_all()
                if not condition.wait_for(lambda: current >= target, timeout=2):
                    raise AssertionError("Manual test clock did not advance")

        def opener(request, timeout=75):
            nonlocal first_request
            with condition:
                started.append((threading.current_thread().name, current))
                if first_request:
                    first_request = False
                    raise self.rate_error("10")
            return io.BytesIO(b"ok")

        pacer = http.RatingHTTP(opener=opener, monotonic=monotonic, sleep=sleep,
                               wall_time=self.clock.wall_time)
        failures = []

        def worker():
            try:
                pacer.open(URL).close()
            except Exception as error:
                failures.append(error)

        one = threading.Thread(target=worker, name="first")
        two = threading.Thread(target=worker, name="second")
        one.start()
        with condition:
            self.assertTrue(condition.wait_for(lambda: len(sleeps) >= 1, timeout=2))
        two.start()
        with condition:
            self.assertTrue(condition.wait_for(lambda: len(sleeps) >= 2, timeout=2))
            self.assertEqual(started, [("first", 0)])
            current = 30
            condition.notify_all()
            self.assertTrue(condition.wait_for(lambda: len(started) >= 2 and len(sleeps) >= 3, timeout=2))
            self.assertGreaterEqual(started[1][1], 30)
            current = 31.25
            condition.notify_all()
        one.join(2)
        two.join(2)
        self.assertFalse(one.is_alive() or two.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(sorted(moment for _name, moment in started), [0, 30, 31.25])


if __name__ == "__main__":
    unittest.main()
