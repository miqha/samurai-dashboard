#!/usr/bin/env python3
"""Cache exact official question-overlap links for the team's tournament IDs.

Only public /tournaments/{id}/intersections metadata is requested. The official
endpoint is undirected and not paginated. A link means some questions overlap;
it does not assert that both tournaments use the entire identical packet.
No question texts, answers, rosters, or private resources are saved.
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


ROOT = Path(__file__).resolve().parents[1]
API = "https://api.rating.chgk.info"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_json(path, data, javascript=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if javascript:
        body = "window.SAMURAI_INTERSECTIONS=" + body.replace("</", "<\\/") + ";"
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(body + "\n", encoding="utf-8")
    temporary.replace(path)


def fetch(tournament_id):
    source = f"{API}/tournaments/{tournament_id}/intersections"
    for attempt in range(3):
        try:
            request = urllib.request.Request(source, headers={
                "Accept": "application/json",
                "User-Agent": "Samurai-CHGK-Dashboard/2.0 (public question-overlap metadata)"})
            with paced_urlopen(request, timeout=50) as response:
                data = json.load(response)
            if not isinstance(data, list):
                raise ValueError("Expected the non-paginated official tournament collection")
            ids = []
            for item in data:
                related_id = item.get("id") if isinstance(item, dict) else None
                if not isinstance(related_id, int) or isinstance(related_id, bool) or related_id <= 0:
                    raise ValueError("Invalid related tournament ID")
                if related_id != tournament_id:
                    ids.append(related_id)
            return {"id": tournament_id, "relatedIds": sorted(set(ids)),
                    "sourceUrl": source, "sourceFetchedAt": now()}
        except (ValueError, urllib.error.URLError, OSError, TimeoutError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code in (400, 401, 403, 404, 429):
                raise
            if attempt == 2:
                raise
            time.sleep(1 + 2 * attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    history = json.loads((args.root / "data/dashboard.json").read_text(encoding="utf-8"))
    ids = sorted({row["id"] for row in history["tournaments"]})
    target = args.root / "data/team-intersections.json"
    previous = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {}
    records = {row["id"]: row for row in previous.get("tournaments", []) if row.get("id") in ids}
    errors = []
    to_fetch = [tournament_id for tournament_id in ids if args.refresh or tournament_id not in records]
    with ThreadPoolExecutor(max_workers=max(1, min(4, args.workers))) as pool:
        pending = {pool.submit(fetch, tournament_id): tournament_id for tournament_id in to_fetch}
        for job in as_completed(pending):
            tournament_id = pending[job]
            try:
                records[tournament_id] = job.result()
            except Exception as error:
                errors.append({"id": tournament_id, "error": str(error)[:300], "at": now()})
    bundle = {"schemaVersion": 1, "fetchedAt": now(), "teamId": history["team"]["id"],
              "source": API + "/tournaments/{id}/intersections",
              "sourceDocumentation": API + "/docs.jsonopenapi",
              "semantics": "Official undirected question-overlap links; not necessarily identical whole packets. The endpoint has no pagination.",
              "complete": len(records) == len(ids) and not errors,
              "tournaments": [records[tournament_id] for tournament_id in ids if tournament_id in records],
              "errors": errors}
    write_json(target, bundle)
    write_json(args.root / "team-intersections.js", bundle, javascript=True)
    print(json.dumps({"tournaments": len(bundle["tournaments"]),
                      "withIntersections": sum(bool(row["relatedIds"]) for row in records.values()),
                      "edges": sum(len(row["relatedIds"]) for row in records.values()),
                      "errors": errors, "complete": bundle["complete"]}, ensure_ascii=False))
    return 0 if bundle["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
