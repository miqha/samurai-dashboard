#!/usr/bin/env python3
"""Build training presets from the team's verified tournament registrations.

Refresh is deliberately derived from freshly refreshed catalog/history/training
snapshots, not another independent network crawl. GotQuestions packet membership
or official Rating packet IDs establish identity; titles are never matched.
Unpublished packets have no known question authors: the explicitly labelled
fallback selects past *authored* questions of the announced Rating editors.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
import hashlib
import math
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def name_key(value):
    return re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", " ", str(value or ""))).strip().casefold().replace("ё", "е")


def positive_id(value):
    return type(value) is int and value > 0


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def build(catalog, training, history, metadata=None, built_at=None):
    if catalog.get("teamHistoryVerified") is not True or catalog.get("complete") is not True:
        raise ValueError("Complete catalog with verified team history is required")
    if training.get("meta", {}).get("complete") is not True:
        raise ValueError("Complete training archive is required")
    team_id = catalog.get("teamId")
    if not positive_id(team_id) or history.get("team", {}).get("id") != team_id:
        raise ValueError("Team identity differs between snapshots")
    registration_ids = catalog.get("teamTournamentIds")
    if not isinstance(registration_ids, list) or any(not positive_id(tid) for tid in registration_ids):
        raise ValueError("Invalid team registrations")
    registration_ids = sorted(set(registration_ids))
    packages = {str(p["id"]): p for p in training.get("packages", [])}
    questions = training.get("questions", [])
    bank_authors, author_questions, by_player, by_name = {}, defaultdict(set), defaultdict(set), defaultdict(set)
    by_package = defaultdict(list)
    for q in questions:
        package_id = str(q.get("packageId", (q.get("package") or {}).get("id")))
        by_package[package_id].append(q)
        flags = q.get("flags") or {}
        # Counts indicate answerable records, matching the training filter.
        playable = not flags.get("missingAnswer") and not (flags.get("missingQuestionText") and not any(m.get("role") in ("question", "handout") and m.get("url") for m in q.get("media", [])))
        for a in q.get("authors", []):
            aid = str(a["id"])
            bank_authors[aid] = a
            if playable:
                author_questions[aid].add(q["id"])
            if positive_id(a.get("playerId")):
                by_player[a["playerId"]].add(aid)
            by_name[name_key(a.get("name"))].add(aid)
    # Raw histories fill expired registrations; the refreshed catalog wins for
    # current and future dates, editors and official GotQuestions links.
    tournaments = {t["id"]: {**t, "dateStart": t.get("date") or t.get("dateStart")} for t in history.get("tournaments", [])}
    tournaments.update(metadata or {})
    tournaments.update({t["id"]: t for t in catalog.get("tournaments", [])})
    played = {t["id"]: t.get("included") is True and t.get("resultsAvailable") is True for t in history.get("tournaments", [])}
    rows = []
    for tid in registration_ids:
        t = tournaments.get(tid)
        if not t:
            raise ValueError(f"Missing tournament metadata for registered tournament {tid}")
        linked = {str(pid) for pid in t.get("gotQuestionsTags", []) if positive_id(pid)}
        linked.update(pid for pid, p in packages.items() if tid in p.get("ratingTournamentIds", []) or p.get("ratingTournamentId") == tid)
        loaded = sorted(linked & set(packages), key=lambda pid: (len(pid), pid))
        target_questions = [q for pid in loaded for q in by_package[pid]]
        actual = {str(a["id"]): a for q in target_questions for a in q.get("authors", [])}
        unmatched, selected = [], []
        if actual:
            basis = "question_credits"
            declared = list(actual.values())
            for aid, a in sorted(actual.items()):
                selected.append({"id": aid, "name": a["name"], "questions": len(author_questions[aid] - {q["id"] for q in target_questions}), "matchMethod": "gotquestions_question_author_id"})
        else:
            basis = "rating_editors" if t.get("editors") else "unavailable"
            declared = t.get("editors") or []
            for editor in declared:
                aid, method = None, None
                tag = editor.get("gotQuestionsTag")
                if positive_id(tag) and f"gq-person-{tag}" in bank_authors:
                    aid, method = f"gq-person-{tag}", "official_gotquestions_person_id"
                elif positive_id(editor.get("id")) and len(by_player[editor["id"]]) == 1:
                    aid, method = next(iter(by_player[editor["id"]])), "published_rating_player_id"
                elif len(by_name[name_key(editor.get("name"))]) == 1:
                    aid, method = next(iter(by_name[name_key(editor.get("name"))])), "unique_exact_full_name"
                if aid:
                    a = bank_authors[aid]
                    selected.append({"id": aid, "name": a["name"], "questions": len(author_questions[aid] - {q["id"] for q in target_questions}), "matchMethod": method})
                else:
                    unmatched.append({"name": editor.get("name") or "Неизвестный редактор", "ratingPlayerId": editor.get("id"), "gotQuestionsTag": tag})
        selected = list({a["id"]: a for a in selected}.values())
        forecast = t.get("difficultyForecast")
        rows.append({"tournamentId": tid, "name": t.get("name") or str(tid), "dateStart": t.get("dateStart"), "dateEnd": t.get("dateEnd"),
                     "teamResultsAvailable": played.get(tid, False), "ratingUrl": f"https://rating.chgk.info/tournament/{tid}", "sourceUrl": f"https://api.rating.chgk.info/tournaments/{tid}",
                     "difficultyForecast": forecast if finite(forecast) else None,
                     "targetPackageIds": sorted(linked), "loadedTargetPackageIds": loaded,
                     "targetPackagesMapping": "official_packet_ids_or_published_rating_links" if linked else "not_available",
                     "authorBasis": basis, "authors": selected, "declaredAuthorCount": len(declared), "matchedAuthorCount": len(selected), "unmatchedAuthors": unmatched,
                     "publishedTargetQuestions": len(target_questions), "targetQuestionsWithAuthors": sum(bool(q.get("authors")) for q in target_questions)})
    rows.sort(key=lambda t: (t.get("dateStart") or "", t["tournamentId"]), reverse=True)
    return {"schemaVersion": 1, "builtAt": built_at or datetime.now(timezone.utc).isoformat(timespec="seconds"), "teamId": team_id,
            "source": {"teamHistory": catalog.get("teamHistorySource"), "teamHistoryCheckedAt": catalog.get("teamHistoryCheckedAt"), "catalogFetchedAt": catalog.get("fetchedAt"), "trainingBuiltAt": training.get("meta", {}).get("builtAt"), "historyFetchedAt": history.get("fetchedAt")},
            "semantics": {"registration": "Official team tournament list; presence is not a guaranteed organizer-confirmed seat", "questionAuthors": "Union of author credits from exactly linked public GotQuestions packets", "editorFallback": "Announced Rating editors, explicitly not the unpublished packet's question authors", "targetPackets": "Known target packet IDs are excluded from training"},
            "coverage": {"registrations": len(rows), "withQuestionAuthors": sum(t["authorBasis"] == "question_credits" for t in rows), "editorFallback": sum(t["authorBasis"] == "rating_editors" for t in rows), "withoutMatchedAuthors": sum(not t["authors"] for t in rows)},
            "tournaments": rows}


def refresh(root=ROOT):
    root = Path(root)
    metadata = {}
    for path in sorted((root / "data/raw").glob("*-meta.json")):
        value = read(path)
        row = value.get("data") or {}
        if positive_id(row.get("id")):
            metadata[row["id"]] = row
    bundle = build(read(root / "data/catalog.json"), read(root / "data/training.json"), read(root / "data/dashboard.json"), metadata)
    bundle["source"]["inputSha256"] = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ("data/catalog.json", "data/training.json", "data/dashboard.json")}
    serialized = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    outputs = [(root / "data/registration-training.json", serialized + "\n"), (root / "registration-training.js", "// Registration author presets, rebuilt with all dashboard data.\nwindow.SAMURAI_REGISTRATION_TRAINING = " + serialized.replace("</", "<\\/") + ";\n")]
    for path, text in outputs:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(path)
    return bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Rebuild from the latest upstream snapshot stages")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    bundle = refresh(args.root)
    print(json.dumps(bundle["coverage"], ensure_ascii=False))


if __name__ == "__main__":
    main()
