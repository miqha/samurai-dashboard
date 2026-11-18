#!/usr/bin/env python3
"""Fetch public tournament metadata for open and forthcoming playing windows.

No question text, answers, jury correspondence, tokens or private endpoints are
requested. Requires only Python's standard library. The module is also imported
by the local dashboard server for refreshes at viewing time.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request
from rating_http import paced_urlopen as urlopen
from refresh_http import refresh_run_id

API = "https://api.rating.chgk.info"
TEAM_ID = 100321
ROOT = Path(__file__).resolve().parents[1]
PAGE_SIZE = 512  # The maximum declared by the official OpenAPI schema.
FORMAT_VERSION = 1


def utc_now():
    return datetime.now(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_time(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def person(value):
    return {"id": value.get("id"),
            "name": " ".join(x for x in (value.get("name"), value.get("surname")) if x),
            "gotQuestionsTag": value.get("gotQuestionsTag")}


def normalize_tournament(raw):
    """Keep the public metadata used by recommendations; do not infer access."""
    fields = ("id", "name", "longName", "type", "dateStart", "dateEnd", "lastEditDate",
              "archive", "dateRequestsAllowedTo", "dateDownloadQuestionsFrom",
              "dateDownloadQuestionsTo", "hideQuestionsTo", "hideResultsTo",
              "difficultyForecast", "trueDL", "questionQty", "paymentCategories",
              "regulationsUrl", "siteUrl", "comment", "teamsCount", "expectedTeams",
              "ratingSystems", "languages", "allowedFlags", "gotQuestionsTags")
    value = {key: raw.get(key) for key in fields}
    # Synch-data fields may be nested for some serializers; top-level wins.
    synch = raw.get("synchData") or {}
    for key in ("archive", "dateRequestsAllowedTo", "dateDownloadQuestionsFrom",
                "dateDownloadQuestionsTo", "hideQuestionsTo", "hideResultsTo"):
        if value[key] is None and key in synch:
            value[key] = synch[key]
    value["editors"] = [person(x) for x in raw.get("editors", [])]
    value["editorGroups"] = raw.get("editorGroups", [])
    town = raw.get("town") or {}
    value["town"] = {"id": town.get("id"), "name": town.get("name"),
                     "country": (town.get("country") or {}).get("name")} if town else None
    value["ratingUrl"] = "https://rating.chgk.info/tournament/" + str(raw["id"])
    # The schema has no authoritative cancelled/registration-open boolean.
    # A missing flag must never become a claim that participation is guaranteed.
    value["cancellationStatus"] = "not-provided-by-api"
    for key in ("canceled", "cancelled", "cancellationStatus"):
        if key in raw:
            value[key] = raw[key]
    return value


def read_json(url, attempts=3):
    error = None
    for attempt in range(attempts):
        try:
            request = Request(url, headers={"User-Agent": "Samurai-CHGK-Dashboard/2.0 (public tournament metadata)",
                                            "Accept": "application/json"})
            with urlopen(request, timeout=75) as response:
                result = json.load(response)
                headers = dict(response.headers.items())
            if not isinstance(result, list):
                raise ValueError("Tournament collection must be a JSON array")
            return result, headers
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            error = exc
            if isinstance(exc, HTTPError) and exc.code in (400, 401, 403, 404, 429):
                break
            if attempt + 1 < attempts:
                time.sleep(0.5 * (attempt + 1))
    raise RuntimeError("Could not read public tournament catalogue: " + str(error))


def make_bundle(rows, pages, as_of, horizon_days, started_at=None):
    date_from = as_of.astimezone(timezone.utc).date().isoformat()
    date_to = (as_of + timedelta(days=horizon_days)).astimezone(timezone.utc).date().isoformat()
    unique = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), int):
            raise ValueError("Malformed tournament in catalogue")
        unique[row["id"]] = normalize_tournament(row)
    tournaments = sorted(unique.values(), key=lambda x: (x.get("dateStart") or "", x["id"]))
    return {
        "schemaVersion": FORMAT_VERSION,
        "fetchedAt": iso(utc_now()),
        "asOf": iso(as_of),
        "requestStartedAt": iso(started_at or as_of),
        "timezone": "Europe/Moscow",
        "source": API + "/tournaments",
        "sourceDocumentation": API + "/docs.jsonopenapi",
        "teamId": TEAM_ID,
        "query": {"dateEnd[after]": date_from, "dateStart[before]": date_to,
                  "itemsPerPage": PAGE_SIZE, "order[id]": "asc"},
        "horizonDays": horizon_days,
        "complete": True,
        "pagination": {"pageSize": PAGE_SIZE, "pages": pages,
                       "terminalEmptyPage": bool(pages and pages[-1]["count"] == 0),
                       "receivedRows": len(rows), "uniqueTournaments": len(tournaments)},
        "coverage": "All tournament types with end on/after the UTC request date and start on/before the horizon date; no lower start bound, to retain long asynchronous windows.",
        "availabilitySemantics": "dateStart/dateEnd define a playing window, not a confirmed venue or registration. Check dateRequestsAllowedTo, archive, format and the organizer. The API has no authoritative cancellation flag.",
        "difficultySemantics": {"difficultyForecast": "Organizer forecast from Rating CHGK; not a Got Questions user rating.",
                                "trueDL": "Observed Rating CHGK TrueDL; not a Got Questions user rating.",
                                "gotQuestionsTags": "Explicit package IDs for https://gotquestions.online/pack/{id}; empty means no official mapping."},
        "tournaments": tournaments,
    }


def fetch_catalog(now=None, horizon_days=90, *, refreshed_history=None):
    """Return a complete catalogue or raise; never return a partial success.

    Dates use inclusive official filters at UTC day precision. The UI applies
    exact date-time boundaries at the actual viewing time. An empty terminal
    page is fetched even after a short page as evidence of complete pagination.
    """
    as_of = parse_time(now) if now is not None else utc_now()
    if not 1 <= horizon_days <= 366:
        raise ValueError("horizon_days must be between 1 and 366")
    query = {"dateEnd[after]": as_of.astimezone(timezone.utc).date().isoformat(),
             "dateStart[before]": (as_of + timedelta(days=horizon_days)).astimezone(timezone.utc).date().isoformat(),
             "itemsPerPage": PAGE_SIZE, "order[id]": "asc"}
    started = utc_now()
    rows = []
    pages = []
    for page in range(1, 101):
        url = API + "/tournaments?" + urlencode({**query, "page": page})
        found, headers = read_json(url)
        pages.append({"page": page, "count": len(found), "url": url,
                      "serverDate": headers.get("Date", headers.get("date")),
                      "etag": headers.get("ETag", headers.get("etag"))})
        if not found:
            bundle = make_bundle(rows, pages, as_of, horizon_days, started)
            # Registration/result history is checked in the same refresh, so a
            # new game after the analytical snapshot cannot be recommended.
            # This custom public endpoint returns the full team's ID list.
            history_source = API + "/teams/" + str(TEAM_ID) + "/tournaments"
            if refreshed_history is None:
                history, _headers = read_json(history_source)
                history_checked = iso(utc_now())
            else:
                history = refreshed_history["data"]
                history_checked = refreshed_history["fetchedAt"]
            identifiers = set()
            for row in history:
                if (not isinstance(row, dict)
                        or type(row.get("idtournament")) is not int
                        or row["idtournament"] <= 0
                        or row.get("idteam", TEAM_ID) != TEAM_ID):
                    raise ValueError("Malformed team tournament history")
                identifiers.add(row["idtournament"])
            bundle["teamTournamentIds"] = sorted(identifiers)
            bundle["teamHistoryCheckedAt"] = history_checked
            bundle["teamHistorySource"] = history_source
            bundle["teamHistoryVerified"] = True
            return bundle
        previous_ids = {row["id"] for row in rows}
        if all(row.get("id") in previous_ids for row in found):
            raise RuntimeError("Pagination did not advance; refusing incomplete catalogue")
        rows.extend(found)
    raise RuntimeError("Pagination exceeded 100 pages; refusing incomplete catalogue")


def refresh_catalog(root=None, now=None, horizon_days=90, *, refreshed_history=None):
    """Fetch and atomically save a catalogue; return the same bundle to callers."""
    bundle = fetch_catalog(now=now, horizon_days=horizon_days, refreshed_history=refreshed_history)
    save_catalog(bundle, root=root)
    return bundle


def save_catalog(bundle, root=None):
    destination = Path(root) if root else ROOT
    (destination / "data").mkdir(parents=True, exist_ok=True)
    text = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    for target, content in ((destination / "data" / "catalog.json", text + "\n"),
                            (destination / "catalog-data.js", "window.SAMURAI_CATALOG=" + text.replace("</", "<\\/") + ";\n")):
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--now", help="Optional ISO date-time for a reproducible cutoff; defaults to real UTC time")
    parser.add_argument("--horizon-days", type=int, default=90)
    parser.add_argument("--reuse-refreshed-history", action="store_true", help="Reuse the same run's verified team ID list")
    args = parser.parse_args()
    refreshed = None
    if args.reuse_refreshed_history:
        refreshed = json.loads((ROOT / "data/raw/tournaments.json").read_text(encoding="utf-8"))
        marker = json.loads((ROOT / ".refresh-context.json").read_text(encoding="utf-8"))
        if (not isinstance(refreshed.get("fetchedAt"), str)
                or refreshed["fetchedAt"] < marker["startedAt"]
                or refreshed.get("refreshRunId") != refresh_run_id(ROOT)
                or marker.get("runId") is None
                or refreshed.get("source") != API + f"/teams/{TEAM_ID}/tournaments"
                or not isinstance(refreshed.get("data"), list)):
            raise ValueError("Team history was not freshly verified in this update")
    bundle = refresh_catalog(now=args.now, horizon_days=args.horizon_days, refreshed_history=refreshed)
    print(json.dumps({"fetchedAt": bundle["fetchedAt"], "tournaments": len(bundle["tournaments"]),
                      "pages": len(bundle["pagination"]["pages"]), "complete": bundle["complete"]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
