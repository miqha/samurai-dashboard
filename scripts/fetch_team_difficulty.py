#!/usr/bin/env python3
"""Refresh public tournament difficulty / GotQuestions links for team history.

Only public tournament metadata is requested, at most four requests at a time.
Existing records are retained when a request fails; errors stay visible.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
from rating_http import paced_urlopen
from refresh_http import refresh_run_id

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "data" / "team-difficulty.json"
API = "https://api.rating.chgk.info"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_history():
    raw = (ROOT / "data.js").read_text()
    return json.loads(raw[raw.index("{"):].strip().rstrip(";"))["tournaments"]


def finite_number(value):
    return value if isinstance(value, (float, int)) and not isinstance(value, bool) else None


def fetch(tournament):
    url = API + "/tournaments/" + str(tournament["id"])
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={
                "Accept": "application/json", "User-Agent": "Samurai-CHGK-Dashboard/1.0 (public statistics)"})
            with paced_urlopen(request, timeout=50) as response:
                data = json.load(response)
            if data.get("id") != tournament["id"]:
                raise ValueError("Unexpected tournament ID")
            return {"id": data["id"], "name": data.get("name"),
                    "dateStart": data.get("dateStart"), "dateEnd": data.get("dateEnd"),
                    "trueDL": finite_number(data.get("trueDL")),
                    "difficultyForecast": finite_number(data.get("difficultyForecast")),
                    "gotQuestionsTags": data.get("gotQuestionsTags") or [],
                    "sourceFetchedAt": now(), "sourceUrl": url}
        except (ValueError, urllib.error.URLError, TimeoutError, OSError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code in (401, 403, 404, 429):
                raise
            if attempt == 2:
                raise
            time.sleep(1 + attempt * 2)


def from_refreshed_metadata(tournament, history, root=ROOT):
    """Reuse this refresh's exact response, never an older metadata cache.

    fetch_data retains all bridge fields in its sanitized metadata. Matching
    the history receipt and the run marker ties reuse to an actual successful
    request in this run; mere file presence or unchanged lastEditDate does not.
    """
    marker = json.loads((root / ".refresh-context.json").read_text(encoding="utf-8"))
    started = marker["startedAt"]
    cached = json.loads((root / "data/raw" / f"{tournament['id']}-meta.json").read_text(encoding="utf-8"))
    data, fetched = cached.get("data") or {}, cached.get("fetchedAt")
    receipt = (tournament.get("sourceFetchedAt") or {}).get("metadata")
    if (not isinstance(started, str) or not isinstance(fetched, str) or fetched < started
            or cached.get("refreshRunId") != refresh_run_id(root)
            or marker.get("runId") is None
            or receipt != fetched or data.get("id") != tournament["id"]
            or cached.get("source") != API + "/tournaments/" + str(tournament["id"])
            or any(key not in data for key in ("trueDL", "difficultyForecast", "gotQuestionsTags"))):
        raise ValueError("Metadata was not freshly verified in this update")
    return {"id": data["id"], "name": data.get("name"), "dateStart": data.get("dateStart"),
            "dateEnd": data.get("dateEnd"), "trueDL": finite_number(data.get("trueDL")),
            "difficultyForecast": finite_number(data.get("difficultyForecast")),
            "gotQuestionsTags": data.get("gotQuestionsTags") or [],
            "sourceFetchedAt": fetched, "sourceUrl": cached["source"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Refresh existing records too")
    parser.add_argument("--reuse-refreshed-metadata", action="store_true", help="Derive from this run's verified fetch_data receipts")
    args = parser.parse_args()
    history = load_history()
    history_bundle = json.loads((ROOT / "data/dashboard.json").read_text(encoding="utf-8"))
    old = json.loads(TARGET.read_text()) if TARGET.exists() else {}
    records = {str(row["id"]): row for row in old.get("tournaments", [])}
    errors = []
    todo = [row for row in history if args.refresh or str(row["id"]) not in records]
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(from_refreshed_metadata, row, history_bundle) if args.reuse_refreshed_metadata
                   else pool.submit(fetch, row): row for row in todo}
        for future in as_completed(pending):
            row = pending[future]
            try:
                records[str(row["id"])] = future.result()
            except Exception as error:
                errors.append({"id": row["id"], "error": str(error), "at": now()})
    snapshot = {"schemaVersion": 1, "fetchedAt": now(), "teamId": 100321,
                "source": API + "/tournaments/{id}",
                "complete": all(str(row["id"]) in records for row in history) and not errors,
                "tournaments": [records[str(row["id"])] for row in history if str(row["id"]) in records],
                "errors": errors}
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    TARGET.write_text(encoded + "\n")
    (ROOT / "team-difficulty.js").write_text("// Public Rating CHGK difficulty metadata.\nwindow.SAMURAI_DIFFICULTY = " + encoded + ";\n")
    measured = sum(row.get("trueDL") is not None for row in snapshot["tournaments"])
    print(f"Saved {len(snapshot['tournaments'])} tournaments, {measured} trueDL values, {len(errors)} errors")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
