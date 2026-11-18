#!/usr/bin/env python3
"""Snapshot the complete public GotQuestions package search for a play-date year.

Only URLs used by the public search interface are read. The search date fields
are startPlayed/endPlayed, not publication dates. Long playing windows can start
before the requested interval; source dates are preserved without inference.
Default execution is offline and validates cached HTML. --refresh downloads each
page once, including one terminal empty page; an HTTP 429 is never retried.
"""

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from refresh_http import read_payload, check_gq_cooldown, record_gq_rate_limit

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://gotquestions.online"
PAGE_SIZE = 100  # Public search UI permits 18–100 results per page.
MAX_PAGES = 100
MAX_RESPONSE_BYTES = 8_000_000
PUSH = re.compile(r"self\.__next_f\.push\(")
ITEMS = re.compile(r'\{"items":')


def search_url(start, end, page=1):
    date.fromisoformat(start)
    date.fromisoformat(end)
    if start > end:
        raise ValueError("The period start must be on/before its end")
    if type(page) is not int or page < 1:
        raise ValueError("page must be a positive integer")
    return ORIGIN + "/search?" + urlencode({
        "type": "packages", "startPlayed": start, "endPlayed": end,
        "sSort": "pDate", "sortDirection": "desc", "limit": PAGE_SIZE,
        "page": page,
    })


def search_result(payload):
    """Read JSON carried by Next's public SSR; never execute page JavaScript."""
    html = payload.decode("utf-8") if isinstance(payload, bytes) else payload
    decoder = json.JSONDecoder()
    chunks = []
    for match in PUSH.finditer(html):
        value, _ = decoder.raw_decode(html, match.end())
        if isinstance(value, list) and len(value) > 1 and value[0] == 1 and isinstance(value[1], str):
            chunks.append(value[1])
    stream = "".join(chunks)
    found = []
    for match in ITEMS.finditer(stream):
        try:
            value, _ = decoder.raw_decode(stream, match.start())
        except ValueError:
            continue
        if isinstance(value.get("metadata"), dict) and isinstance(value.get("items"), list):
            found.append(value)
    if len(found) != 1:
        raise ValueError("Expected exactly one public package-search result")
    metadata = found[0]["metadata"]
    for key in ("totalResults", "page", "pageSize", "totalPages"):
        if type(metadata.get(key)) is not int or metadata[key] < 0:
            raise ValueError("Invalid public search pagination metadata")
    return found[0]


def normalized_package(raw):
    if not isinstance(raw, dict) or type(raw.get("id")) is not int or raw["id"] <= 0:
        raise ValueError("Invalid GotQuestions package ID")
    if raw.get("published") is not True:
        raise ValueError("The public catalogue contains an unpublished package")
    if type(raw.get("questionCount")) is not int or raw["questionCount"] < 0:
        raise ValueError("Invalid declared package question count")
    result = dict(raw)
    for key in ("startDate", "endDate", "pubDate"):
        value = result.get(key)
        if isinstance(value, str) and value.startswith("$D"):
            value = value[2:]
        if value is not None:
            if not isinstance(value, str):
                raise ValueError("Invalid source package date")
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("Source package dates must include timezone")
        result[key] = value
    return result


def build_catalog(page_payloads, start, end, fetched_at=None):
    """Require every result and a terminal empty page before claiming complete."""
    search_url(start, end)
    if not page_payloads:
        raise ValueError("No cached search pages")
    first = search_result(page_payloads[0])
    expected = first["metadata"]
    total, total_pages = expected["totalResults"], expected["totalPages"]
    if total_pages > MAX_PAGES or expected["pageSize"] != PAGE_SIZE:
        raise ValueError("Unexpected search page size or excessive page count")
    if total_pages != (total + PAGE_SIZE - 1) // PAGE_SIZE:
        raise ValueError("Inconsistent public search totalPages")
    if len(page_payloads) != max(1, total_pages + 1):
        raise ValueError("Missing search pages or terminal empty page")
    packages, pages, identifiers = [], [], set()
    for index, payload in enumerate(page_payloads, 1):
        result = search_result(payload)
        meta, rows = result["metadata"], result["items"]
        if meta["page"] != index or meta["pageSize"] != PAGE_SIZE:
            raise ValueError("The source did not retain the requested page")
        terminal = index > total_pages
        if terminal:
            # GotQuestions returns totalResults=0 for out-of-range pages.
            if rows:
                raise ValueError("Expected an empty terminal search page")
        else:
            if meta["totalResults"] != total or meta["totalPages"] != total_pages:
                raise ValueError("Search catalogue changed during pagination")
            expected_rows = min(PAGE_SIZE, total - (index - 1) * PAGE_SIZE)
            if len(rows) != expected_rows:
                raise ValueError("Incomplete search result page")
        for raw in rows:
            package = normalized_package(raw)
            if package["id"] in identifiers:
                raise ValueError("Duplicate package across search pages")
            identifiers.add(package["id"])
            packages.append(package)
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        pages.append({"page": index, "count": len(rows), "metadata": meta,
                      "url": search_url(start, end, index),
                      "sha256": hashlib.sha256(payload).hexdigest(),
                      "sourceFile": f"data/training-year-sources/catalog/page-{index}.html"})
    if len(packages) != total:
        raise ValueError("Unique package count does not equal public result count")
    fetched_at = fetched_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {
        "schemaVersion": 1,
        "meta": {
            "from": start, "toInclusive": end, "complete": True,
            "fetchedAt": fetched_at, "sourceUrl": search_url(start, end),
            "dateBasis": "GotQuestions public package search startPlayed/endPlayed; dates of play, not publication",
            "periodDefinitionRu": "Открытый фильтр GotQuestions «Сыграно от/до»; исходные даты пакетов сохранены",
            "dateFilterSemantics": "Long playing windows may begin before from. Source dates are preserved; no inference from packet title.",
            "totalResults": total, "pages": pages, "terminalEmptyPage": True,
            "sourceQuestions": sum(p["questionCount"] for p in packages),
            "coverage": "All packages returned by the public GotQuestions package search for this play-date interval; question text coverage is verified separately.",
        },
        "packages": packages,
    }


def download_page(url):
    check_gq_cooldown(ROOT)
    request = Request(url, headers={
        "User-Agent": "Samurai-CHGK-Dashboard/3.0 (public training archive)",
        "Accept": "text/html",
        "Accept-Encoding": "gzip",
    })
    # No retries: in particular, respect GotQuestions rate-limit responses.
    try:
        with urlopen(request, timeout=75) as response:
            payload = read_payload(response, MAX_RESPONSE_BYTES)
    except HTTPError as error:
        if error.code == 429:
            record_gq_rate_limit(ROOT, error)
        raise
    return payload


def create_catalog(root, start, end, refresh=False):
    folder = root / "data/training-year-sources/catalog"
    folder.mkdir(parents=True, exist_ok=True)
    request_file = folder / "request.json"
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not refresh:
        request_meta = json.loads(request_file.read_text(encoding="utf-8"))
        if (request_meta.get("from"), request_meta.get("toInclusive")) != (start, end):
            raise ValueError("The cached catalogue belongs to a different date interval")
        fetched_at = request_meta.get("fetchedAt")
        if not isinstance(fetched_at, str):
            raise ValueError("The cache is missing its retrieval timestamp")
    payloads = []
    total_pages = None
    for page in range(1, MAX_PAGES + 2):
        cache = folder / f"page-{page}.html"
        if refresh:
            if page > 1:
                time.sleep(2)
            payload = download_page(search_url(start, end, page))
            search_result(payload)  # A login/error page must not replace cache.
        else:
            payload = cache.read_bytes()
        payloads.append(payload)
        if total_pages is None:
            total_pages = search_result(payload)["metadata"]["totalPages"]
            if total_pages > MAX_PAGES:
                raise ValueError("Public search exceeds maximum supported pages")
        if page >= max(1, total_pages + 1):
            break
    result = build_catalog(payloads, start, end, fetched_at=fetched_at)
    if refresh:
        # Keep the old catalogue intact until every requested page is validated.
        for page, payload in enumerate(payloads, 1):
            (folder / f"page-{page}.html").write_bytes(payload)
        request_file.write_text(json.dumps({"from": start, "toInclusive": end,
                                           "fetchedAt": fetched_at}, indent=2) + "\n", encoding="utf-8")
    destination = root / "data/training-year-catalog.json"
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(destination)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    result = create_catalog(args.root, args.start, args.end, args.refresh)
    print(json.dumps({"packages": len(result["packages"]),
                      "declaredQuestions": result["meta"]["sourceQuestions"],
                      "complete": result["meta"]["complete"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
