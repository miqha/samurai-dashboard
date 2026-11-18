"""Compressed public responses and conservative HTTP cache validation.

Saved bodies are reused on refresh only after a successful conditional GET.
A 304 validates the representation; it does not pretend the body was downloaded
again. Callers retain fetchedAt and record the separate checkedAt timestamp.
"""

import gzip
import io
import json
from pathlib import Path
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import math
import time
import threading
from urllib.error import HTTPError

GQ_MIN_INTERVAL_SECONDS = 0.5  # At most two public request starts per second.
_COOLDOWN_LOCK = threading.Lock()


def gq_cooldown_until(root):
    target = Path(root) / ".gq-cooldown.json"
    if not target.exists():
        return 0.0
    value = json.loads(target.read_text(encoding="utf-8"))
    until = value.get("untilEpoch")
    if isinstance(until, (int, float)) and not isinstance(until, bool) and math.isfinite(until):
        return until
    raise ValueError("Invalid GotQuestions cooldown record")


def check_gq_cooldown(root):
    if gq_cooldown_until(root) > time.time():
        raise RuntimeError("GotQuestions Retry-After cooldown is still active")


def record_gq_rate_limit(root, error):
    """Persist an upstream 429 so the next refresh cannot restart immediately."""
    value = (error.headers or {}).get("Retry-After", "")
    delay = 60.0
    try:
        parsed = float(value)
        if math.isfinite(parsed) and parsed >= 0:
            delay = max(delay, parsed)
    except (TypeError, ValueError):
        try:
            instant = parsedate_to_datetime(str(value))
            if instant.tzinfo is None:
                instant = instant.replace(tzinfo=timezone.utc)
            delay = max(delay, instant.timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            pass
    with _COOLDOWN_LOCK:
        target = Path(root) / ".gq-cooldown.json"
        until = max(gq_cooldown_until(root), time.time() + delay)
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(json.dumps({"untilEpoch": until, "httpStatus": 429,
            "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}) + "\n", encoding="utf-8")
        temporary.replace(target)


def refresh_run_id(root):
    marker = Path(root) / ".refresh-context.json"
    if not marker.exists():
        return None
    value = json.loads(marker.read_text(encoding="utf-8")).get("runId")
    if not isinstance(value, str) or len(value) != 32 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("Invalid isolated refresh context")
    return value


def validators(headers):
    """Keep only standard validators, never cookies or unrelated headers."""
    if headers is None:
        return {}
    result = {}
    for name in ("ETag", "Last-Modified"):
        value = headers.get(name) or headers.get(name.lower())
        if isinstance(value, str) and value.strip() and "\r" not in value and "\n" not in value:
            result[name] = value
    return result


def conditional_headers(cached):
    result = {"Accept-Encoding": "gzip"}
    source = (cached or {}).get("httpValidators") or {}
    if isinstance(source, dict):
        source = validators(source)
        if source.get("ETag"):
            result["If-None-Match"] = source["ETag"]
        elif source.get("Last-Modified"):
            result["If-Modified-Since"] = source["Last-Modified"]
    return result


def read_payload(response, limit):
    """Bound the decoded size as well as the compressed transfer size."""
    headers = getattr(response, "headers", {}) or {}
    encoding = (headers.get("Content-Encoding") or headers.get("content-encoding") or "identity").lower()
    if encoding not in ("identity", "gzip"):
        raise ValueError("Unsupported public response content encoding")
    wire = response.read(limit + 1)
    if len(wire) > limit:
        raise ValueError("Public response exceeds the transfer size limit")
    if encoding == "gzip":
        with gzip.GzipFile(fileobj=io.BytesIO(wire)) as stream:
            payload = stream.read(limit + 1)
    else:
        payload = wire
    if len(payload) > limit:
        raise ValueError("Public response exceeds the decoded size limit")
    return payload


def refresh_payload(request, cached, opener, *, timeout=75, limit=20_000_000):
    """Return (body or None on 304, response validators).

    The caller supplies an already integrity-checked cached body. A spurious
    304 without a request validator is an error and cannot validate stale data.
    Network errors and 429 are propagated; no stale-on-error fallback exists.
    """
    for key, value in conditional_headers(cached).items():
        request.add_header(key, value)
    conditional = bool(request.get_header("If-none-match") or request.get_header("If-modified-since"))
    try:
        with opener(request, timeout=timeout) as response:
            if getattr(response, "status", None) == 304:
                if not cached or not conditional:
                    raise ValueError("Unsolicited HTTP 304 without a verified cached representation")
                return None, {**((cached or {}).get("httpValidators") or {}), **validators(response.headers)}
            return read_payload(response, limit), validators(getattr(response, "headers", None))
    except HTTPError as error:
        if error.code != 304:
            raise
        try:
            if not cached or not conditional:
                raise ValueError("Unsolicited HTTP 304 without a verified cached representation") from error
            return None, {**(cached.get("httpValidators") or {}), **validators(error.headers)}
        finally:
            error.close()
