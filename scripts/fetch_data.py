#!/usr/bin/env python3
"""Download public Rating CHGK results and build an offline dashboard snapshot.

Only Python's standard library is required. Cached results intentionally omit
opponents' rosters, appeal answers/comments and all patronymics.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import sys
import time
import urllib.error
import urllib.request
from rating_http import paced_urlopen
from refresh_http import refresh_run_id

API = "https://api.rating.chgk.info"
TEAM_ID = 100321
ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
VERSION = 2


def person(p):
    p = p.get("player", p)
    return {"id": p.get("id"), "name": " ".join(x for x in (p.get("name"), p.get("surname")) if x)}


def credit_member(p):
    if p.get("player"):
        return person(p["player"])
    if p.get("players"):
        return {"id": None, "name": p.get("name"), "tentative": True,
                "candidates": [person(v) for v in p["players"]]}
    return {"id": None, "name": p.get("name"), "unmatched": True}


def team_card(d):
    return {"id": d["id"], "name": d["name"], "town": (d.get("town") or {}).get("name"),
            "oldNames": [{"name": v["name"], "dateTo": v.get("dateTo")} for v in d.get("oldNames", [])]}


def metadata(d):
    keys = ("id", "name", "longName", "dateStart", "dateEnd", "lastEditDate", "type",
            "questionQty", "teamsCount", "rating", "canceledQuestions", "archive", "hideResultsTo",
            "hideQuestionsTo", "siteUrl", "difficultyForecast", "trueDL", "gotQuestionsTags")
    out = {key: d.get(key) for key in keys}
    out["editors"] = [person(p) for p in d.get("editors", [])]
    out["credits"] = [{"tour": c.get("tour"), "questions": c.get("questions"),
                       "authors": [credit_member(p) for p in c.get("authors", [])],
                       "editors": [credit_member(p) for p in c.get("editors", [])]}
                      for c in d.get("credits", []) if c.get("authors") or c.get("editors")]
    return out


def results(d):
    if not isinstance(d, list):
        raise ValueError("Expected results array")
    out = []
    for r in d:
        t = r.get("team") or {}
        item = {"teamId": t.get("id"), "teamName": t.get("name"),
                "mask": r.get("mask"), "score": r.get("questionsTotal"),
                "position": r.get("position"), "resultsAvailable": r.get("resultsAvailable")}
        if t.get("id") == TEAM_ID:
            item["players"] = [person(p) for p in r.get("teamMembers", [])]
            item["rating"] = r.get("rating")
            item["controversials"] = [{"questionNumber": c.get("questionNumber"), "status": c.get("status")}
                                      for c in r.get("controversials", [])]
        out.append(item)
    return out


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def cache_fetch(path, filename, cleaner, refresh=False):
    target = RAW / filename
    if target.exists() and not refresh:
        cache = json.loads(target.read_text())
        if cache.get("schemaVersion") == VERSION:
            return cache
    last_error = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(API + path, headers={"User-Agent": "Samurai-CHGK-Dashboard/1.0 (public statistics)", "Accept": "application/json"})
            with paced_urlopen(req, timeout=75) as response:
                raw = json.load(response)
            cache = {"schemaVersion": VERSION, "source": API + path, "fetchedAt": now(), "data": cleaner(raw)}
            run_id = refresh_run_id(ROOT)
            if run_id:
                cache["refreshRunId"] = run_id
            temp = target.with_suffix(".tmp")
            temp.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")) + "\n")
            temp.replace(target)
            return cache
        except (urllib.error.URLError, ValueError, TimeoutError, OSError) as exc:
            last_error = exc
            if isinstance(exc, urllib.error.HTTPError) and exc.code in (401, 403, 404, 429):
                break
            if attempt < 4:
                time.sleep(1.6 * 2 ** attempt + random.random())
    raise RuntimeError(f"{path}: {last_error}")


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def canceled_numbers(values):
    """The API uses absolute 1-based numbers; tolerate object-shaped variants."""
    out = []
    for q in values or []:
        if isinstance(q, dict):
            q = q.get("questionNumber", q.get("number"))
        if isinstance(q, str) and q.isdigit():
            q = int(q)
        if isinstance(q, int) and q > 0:
            out.append(q)
    return sorted(set(out))


def derive(meta, rows, cutoff):
    own = next((r for r in rows if r["teamId"] == TEAM_ID), None)
    question_qty = meta.get("questionQty") or {}
    if isinstance(question_qty, dict):
        question_qty = [question_qty[k] for k in sorted(question_qty, key=lambda x: int(x))]
    else:
        question_qty = list(question_qty)
    mask = (own or {}).get("mask") or ""
    total_questions = sum(v for v in question_qty if numeric(v)) or len(mask)
    canceled = canceled_numbers(meta.get("canceledQuestions"))
    valid = [r for r in rows if r.get("resultsAvailable") is True and numeric(r.get("score"))]
    # Benchmark against opponents only. The score distribution and field size
    # below still describe the entire published tournament, including our team.
    opponents = [r for r in valid if r.get("teamId") != TEAM_ID]
    counts, rates, successes = [], [], []
    for index in range(total_questions):
        known = [r["mask"][index] for r in opponents
                 if isinstance(r.get("mask"), str) and len(r["mask"]) > index and r["mask"][index] in "01"]
        counts.append(len(known))
        successes.append(known.count("1"))
        rates.append(round(known.count("1") / len(known), 6) if known and index + 1 not in canceled else None)
    score = (own or {}).get("score")
    exclude = None
    if (meta.get("dateStart") or "9999")[:10] > cutoff:
        exclude = "future"
    elif own is None:
        exclude = "team-result-missing"
    elif own.get("resultsAvailable") is not True or not numeric(score):
        exclude = "unpublished"
    known_own = [i for i, c in enumerate(mask[:total_questions]) if c in "01" and i + 1 not in canceled]
    comparable = [i for i in known_own if rates[i] is not None]
    percentile = None
    if numeric(score) and valid:
        lower = sum(r["score"] < score for r in valid)
        same = sum(r["score"] == score for r in valid)
        # Tie-adjusted percentile excludes own row from ties. A singleton has
        # no opponents and therefore no defined comparative percentile.
        percentile = round(100 * (lower + (same - 1) / 2) / (len(valid) - 1), 4) if len(valid) > 1 else None
    typ = meta.get("type") or {}
    credit_rows = []
    for c in meta.get("credits", []):
        questions = c.get("questions")
        credit_rows.append({**c, "from": questions[0] if isinstance(questions, list) and questions else None,
                            "to": questions[-1] if isinstance(questions, list) and questions else None})
    distribution = Counter(r["score"] for r in valid)
    canceled_ones = [q for q in canceled if len(mask) >= q and mask[q - 1] == "1"]
    issues = []
    if mask and len(mask) != total_questions:
        issues.append("mask-length-mismatch")
    if numeric(score) and mask and score not in (mask.count("1"), mask.count("1") - len(canceled_ones)):
        issues.append("mask-score-mismatch")
    return {
        "id": meta["id"], "name": meta.get("name"), "date": meta.get("dateStart"), "dateEnd": meta.get("dateEnd"),
        "type": typ.get("id"), "typeName": typ.get("name"), "questionQty": question_qty,
        "totalQuestions": total_questions, "canceledQuestions": canceled,
        "editors": meta.get("editors", []), "questionCredits": credit_rows,
        "teamName": (own or {}).get("teamName"), "score": score, "position": (own or {}).get("position"),
        "fieldSize": len(valid), "registeredTeams": len(rows), "mask": mask,
        "players": (own or {}).get("players", []), "rating": (own or {}).get("rating"),
        "fieldRates": rates, "fieldCounts": counts, "fieldSuccesses": successes,
        "scoreDistribution": [{"score": s, "count": n} for s, n in sorted(distribution.items())],
        "percentile": percentile,
        "expectedScore": round(sum(rates[i] for i in comparable), 4) if comparable else None,
        "comparableQuestions": len(comparable), "knownQuestions": len(known_own),
        "maskTaken": sum(mask[i] == "1" for i in known_own),
        "resultsAvailable": (own or {}).get("resultsAvailable") is True,
        "included": exclude is None, "exclusionReason": exclude,
        "ongoing": (meta.get("dateEnd") or "")[:10] > cutoff,
        "resultsHiddenUntil": meta.get("hideResultsTo"),
        "controversials": (own or {}).get("controversials", []), "dataIssues": issues,
        "url": f"https://rating.chgk.info/tournament/{meta['id']}",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Refresh all public API caches")
    parser.add_argument("--cutoff", default="2026-11-07", help="Last dashboard date, YYYY-MM-DD")
    parser.add_argument("--workers", type=int, default=5)
    args = parser.parse_args()
    datetime.strptime(args.cutoff, "%Y-%m-%d")
    RAW.mkdir(parents=True, exist_ok=True)
    team = cache_fetch(f"/teams/{TEAM_ID}", "team.json", team_card, args.refresh)
    entries = cache_fetch(f"/teams/{TEAM_ID}/tournaments", "tournaments.json", lambda x: x, args.refresh)
    ids = sorted({r["idtournament"] for r in entries["data"]})
    errors, metadata_cache, result_cache = [], {}, {}
    jobs = []
    with ThreadPoolExecutor(max_workers=max(1, min(6, args.workers))) as pool:
        for tid in ids:
            jobs.append(("meta", tid, pool.submit(cache_fetch, f"/tournaments/{tid}", f"{tid}-meta.json", metadata, args.refresh)))
            jobs.append(("results", tid, pool.submit(cache_fetch, f"/tournaments/{tid}/results?includeTeamMembers=1&includeMasksAndControversials=1&includeRatingB=1", f"{tid}-results.json", results, args.refresh)))
        lookup = {job: (kind, tid) for kind, tid, job in jobs}
        for index, job in enumerate(as_completed(lookup), 1):
            kind, tid = lookup[job]
            try:
                target = metadata_cache if kind == "meta" else result_cache
                target[tid] = job.result()
            except Exception as exc:
                errors.append({"tournament": tid, "part": kind, "error": str(exc)})
            if index % 10 == 0 or index == len(lookup):
                print(f"Fetched/cached {index}/{len(lookup)} tournament resources; errors: {len(errors)}", flush=True)
    tournaments = []
    for tid in ids:
        if tid in metadata_cache and tid in result_cache:
            t = derive(metadata_cache[tid]["data"], result_cache[tid]["data"], args.cutoff)
            t["sourceFetchedAt"] = {"metadata": metadata_cache[tid]["fetchedAt"], "results": result_cache[tid]["fetchedAt"]}
            tournaments.append(t)
    tournaments.sort(key=lambda t: (t.get("date") or "", t["id"]))
    included = [t for t in tournaments if t["included"]]
    excluded = [{"id": t["id"], "name": t["name"], "reason": t["exclusionReason"]} for t in tournaments if not t["included"]]
    coverage = {"listedTournaments": len(ids), "loadedTournaments": len(tournaments), "includedTournaments": len(included),
                "withMasks": sum(bool(t["knownQuestions"]) for t in included), "withRosters": sum(bool(t["players"]) for t in included),
                "withEditors": sum(bool(t["editors"]) for t in included),
                "withAuthorCredits": sum(any(c["authors"] for c in t["questionCredits"]) for t in included),
                "withQuestionCredits": sum(bool(t["questionCredits"]) for t in included),
                "withFieldMasks": sum(any(n for n in t["fieldCounts"]) for t in included),
                "unknownMaskSymbols": sum(sum(c not in "01" for i,c in enumerate(t["mask"][:t["totalQuestions"]]) if i+1 not in t["canceledQuestions"]) for t in included),
                "canceledQuestions": sum(len(t["canceledQuestions"]) for t in included),
                "rosterPlayerCount": len({p["id"] for t in included for p in t["players"]}),
                "errors": errors, "excluded": excluded,
                "issues": [{"id": t["id"], "issues": t["dataIssues"]} for t in included if t["dataIssues"]]}
    all_fetched = [team["fetchedAt"], entries["fetchedAt"]] + [v["fetchedAt"] for v in metadata_cache.values()] + [v["fetchedAt"] for v in result_cache.values()]
    data = {"schemaVersion": VERSION, "team": team["data"], "fetchedAt": max(all_fetched), "builtAt": now(), "cutoff": args.cutoff,
            "source": {"api": API, "team": f"https://rating.chgk.info/team/{TEAM_ID}", "site": "https://rating.chgk.org", "cacheFirstFetchedAt": min(all_fetched)},
            "tournaments": tournaments, "coverage": coverage}
    serialized = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    (ROOT / "data" / "dashboard.json").write_text(serialized + "\n")
    (ROOT / "data.js").write_text("// Public data snapshot. Regenerate with scripts/fetch_data.py.\nwindow.SAMURAI_DATA = " + serialized.replace("</", "<\\/") + ";\n")
    print(json.dumps(coverage, ensure_ascii=False, indent=2))
    if errors:
        sys.exit(2)


if __name__ == "__main__":
    main()
