#!/usr/bin/env python3
"""Build the verified GotQuestions ↔ Rating trueDL bridge without spoilers.

The official Rating API exposes both trueDL and exact gotQuestionsTags packet
IDs. This adapter reuses those verified metadata caches rather than matching
packet titles or scraping questions. It does not claim question-level trueDL.
Optional --probe-homepage makes at most one normal request to check availability;
429 is cached, respected and never retried in the run.
"""

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
import urllib.error
import urllib.request
from refresh_http import check_gq_cooldown, record_gq_rate_limit


ROOT = Path(__file__).resolve().parents[1]
API = "https://api.rating.chgk.info"
GQ = "https://gotquestions.online/"
SCHEMA = API + "/docs.jsonopenapi"
EXPLANATION = "https://pecheny.me/blog/truedl/"
AUTHOR_CODE = "https://code.pecheny.me/pecheny/truedl"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def probe_homepage(target, refresh=False, ttl_hours=24):
    """Availability only: never fetch packet/question text or evade rate limits."""
    cached = read_json(target)
    if cached:
        fetched = datetime.fromisoformat(cached["checkedAt"])
        age = (datetime.now(timezone.utc) - fetched).total_seconds()
        # A 429 is always respected for at least one day, even with --refresh.
        retry_after = cached.get("retryAfterSeconds") or 0
        ttl = max(ttl_hours * 3600, retry_after, 86400 if cached.get("httpStatus") == 429 else 0)
        if age < ttl and (not refresh or cached.get("httpStatus") == 429):
            return cached
    observation = {"url": GQ, "checkedAt": now(), "httpStatus": None,
                   "status": "unavailable", "requestCount": 1,
                   "questionTextsDownloaded": False, "retried": False}
    request = urllib.request.Request(GQ, headers={
        "User-Agent": "Samurai-CHGK-Dashboard/1.0 (public metadata availability)",
        "Accept": "text/html"})
    try:
        check_gq_cooldown(target.parent.parent)
        with urllib.request.urlopen(request, timeout=30) as response:
            observation["httpStatus"] = response.status
            observation["status"] = "reachable"
            # Availability is sufficient; deliberately do not read the body.
    except urllib.error.HTTPError as error:
        observation["httpStatus"] = error.code
        observation["status"] = "rate_limited" if error.code == 429 else "http_error"
        retry_after = error.headers.get("Retry-After", "")
        if retry_after.isdigit():
            observation["retryAfterSeconds"] = int(retry_after)
        if error.code == 429:
            record_gq_rate_limit(target.parent.parent, error)
    except (urllib.error.URLError, OSError, TimeoutError):
        observation["status"] = "network_error"
    write_json(target, observation)
    return observation


def normalize(item, snapshot):
    tournament_id = item.get("id", item.get("tournamentId"))
    if not isinstance(tournament_id, int) or isinstance(tournament_id, bool) or tournament_id <= 0:
        return None
    dl = item.get("trueDL")
    forecast = item.get("difficultyForecast", item.get("forecast"))
    tags = item.get("gotQuestionsTags", item.get("packetIds")) or []
    packet_ids = sorted({tag for tag in tags if isinstance(tag, int) and not isinstance(tag, bool) and tag > 0})
    fetched_at = item.get("sourceFetchedAt", item.get("fetchedAt")) or snapshot.get("fetchedAt")
    return {"tournamentId": tournament_id, "name": item.get("name"),
            "dateStart": item.get("dateStart"), "dateEnd": item.get("dateEnd"),
            "trueDL": dl if finite_number(dl) and 0 <= dl <= 10 else None,
            "forecast": forecast if finite_number(forecast) and forecast > 0 else None,
            "packetIds": packet_ids,
            "packetUrls": [f"{GQ}pack/{tag}" for tag in packet_ids],
            "mapping": "official_gotQuestionsTags" if packet_ids else "not_published_in_rating_api",
            "metricSource": "Rating API trueDL; same published scale as GotQuestions",
            "source": item.get("sourceUrl") or f"{API}/tournaments/{tournament_id}",
            "fetchedAt": fetched_at}


def build(snapshots, probe):
    by_id = {}
    source_files = []
    for file_name, snapshot in snapshots:
        source_files.append(file_name)
        for item in snapshot.get("tournaments", []):
            row = normalize(item, snapshot)
            if row is None:
                continue
            existing = by_id.get(row["tournamentId"])
            if existing is None or (row["fetchedAt"] or "") >= (existing.get("fetchedAt") or ""):
                by_id[row["tournamentId"]] = row
    tournaments = sorted(by_id.values(), key=lambda t: (t.get("dateStart") or "", t["tournamentId"]))
    return {"schemaVersion": 1, "builtAt": now(),
            "status": "truedl_bridge_available" if tournaments else "waiting_for_rating_metadata",
            "source": {"gotQuestions": GQ, "ratingApi": API, "apiSchema": SCHEMA,
                       "methodDescription": EXPLANATION, "authorRepository": AUTHOR_CODE,
                       "cacheFiles": source_files},
            "directGotQuestions": probe or {"status": "not_probed", "url": GQ, "httpStatus": None},
            "metrics": {
                "trueDL": {"scope": "tournament", "scale": [0, 10], "higherMeans": "harder",
                           "label": "Фактическая сложность trueDL",
                           "provider": "Rating CHGK API",
                           "sameScaleAs": "GotQuestions Сложность trueDL",
                           "interpretation": "trueDL 5: команда с 251–500 мест рейтинга берёт в среднем половину вопросов.",
                           "notQuestionLevel": True},
                "forecast": {"scope": "tournament", "label": "Прогноз организаторов",
                             "mayDifferFromActualTrueDL": True},
                "questionDifficulty": {"status": "not_verified_from_gotquestions",
                                       "fallback": "empirical_opponent_take_rate_from_rating_masks",
                                       "label": "На уровне вопроса используется доля взятия поля; это отдельная метрика."},
                "likes": {"usedAsDifficulty": False,
                          "reason": "Пользовательские реакции не равны статистической сложности."}},
            "limitations": [
                "Пакеты сопоставляются только через официальный gotQuestionsTags; названия не сопоставляются нечётким поиском.",
                "Сложность trueDL относится к турниру; она не присваивается каждому вопросу пакета.",
                "Один пакет может соответствовать нескольким турнирам с различными trueDL из-за разных полей участников.",
                "Наличие пакета в базе не доказывает открытое окно рейтингового отыгрыша.",
                "Прямой сайт GotQuestions может ограничивать запросы; это не мешает читать trueDL из официального Rating API."],
            "tournaments": tournaments,
            "coverage": {"tournaments": len(tournaments),
                         "withTrueDL": sum(t["trueDL"] is not None for t in tournaments),
                         "withForecast": sum(t["forecast"] is not None for t in tournaments),
                         "withVerifiedPacketIds": sum(bool(t["packetIds"]) for t in tournaments),
                         "uniquePackets": len({p for t in tournaments for p in t["packetIds"]}),
                         "questionLevelGotQuestionsRatings": 0,
                         "questionTextsDownloaded": False,
                         "questionAuthorsDownloaded": False}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--difficulty", type=Path, help="Verified team-difficulty.json metadata cache")
    parser.add_argument("--catalog", type=Path, help="Optional verified live-tournament metadata cache")
    parser.add_argument("--probe-homepage", action="store_true", help="Check direct source once, respecting cached 429")
    parser.add_argument("--refresh-probe", action="store_true", help="Refresh a successful availability probe only")
    args = parser.parse_args()
    difficulty = args.difficulty or args.root / "data/team-difficulty.json"
    candidates = [difficulty]
    if args.catalog:
        candidates.append(args.catalog)
    snapshots = [(str(path.relative_to(args.root)) if path.is_relative_to(args.root) else str(path), read_json(path))
                 for path in candidates if path.exists()]
    probe_path = args.root / "data/gotquestions-source-status.json"
    probe = probe_homepage(probe_path, args.refresh_probe) if args.probe_homepage else read_json(probe_path)
    result = build(snapshots, probe)
    target = args.root / "data/gotquestions.json"
    write_json(target, result)
    print(json.dumps({"output": str(target), "status": result["status"],
                      "coverage": result["coverage"], "directGotQuestions": result["directGotQuestions"]}, ensure_ascii=False))
    return 0 if snapshots else 2


if __name__ == "__main__":
    raise SystemExit(main())
