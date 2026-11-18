#!/usr/bin/env python3
"""Build a provenance-preserving author-credit audit from the dashboard cache.

This does not invent question-level authors from tour credits. Run fetch_data.py
first to refresh public tournament metadata, then run this script. No question
texts, packet files, authentication credentials, or private endpoints are read.
"""

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from math import fsum
from pathlib import Path


def audit(tournaments):
    groups = []
    covered, known, taken = set(), set(), set()
    expectations = {}
    overlaps, singleton_ranges, ambiguous = [], [], []
    unmatched = Counter()
    total_questions = 0
    for tournament in tournaments:
        total_questions += tournament.get("knownQuestions", 0)
        seen = {}
        for index, credit in enumerate(tournament.get("questionCredits", [])):
            authors = credit.get("authors", [])
            if not authors:
                continue
            span = credit.get("questions")
            first = credit.get("from") or (span[0] if span else 1)
            last = credit.get("to") or (span[1] if span else tournament["totalQuestions"])
            first, last = max(1, first), min(last, tournament["totalQuestions"])
            group_id = f"{tournament['id']}:{index}:{first}-{last}"
            if first == last:
                singleton_ranges.append(group_id)
            for author in authors:
                if author.get("tentative") or author.get("candidates"):
                    ambiguous.append({"groupId": group_id, "credit": author})
                elif not author.get("id"):
                    unmatched[author.get("name") or "Без имени"] += 1
            group_known, group_taken = 0, 0
            group_expected = []
            for number in range(first, last + 1):
                key = (tournament["id"], number)
                if number in seen:
                    overlaps.append({"tournamentId": key[0], "question": number,
                                     "groups": [seen[number], group_id]})
                seen[number] = group_id
                covered.add(key)
                mask = tournament.get("mask") or ""
                if number <= len(mask) and mask[number - 1] in "01":
                    known.add(key)
                    group_known += 1
                    rates = tournament.get("fieldRates") or []
                    rate = rates[number - 1] if number <= len(rates) else None
                    if rate is not None:
                        expectations[key] = rate
                        group_expected.append(rate)
                    if mask[number - 1] == "1":
                        taken.add(key)
                        group_taken += 1
            groups.append({"groupId": group_id, "tournamentId": tournament["id"],
                           "tournamentName": tournament["name"],
                           "tour": credit.get("tour"), "from": first, "to": last,
                           "authors": authors, "knownQuestions": group_known,
                           "taken": group_taken, "fieldQuestions": len(group_expected),
                           "fieldExpected": fsum(group_expected),
                           "source": f"https://api.rating.chgk.info/tournaments/{tournament['id']}",
                           "attribution": "author_credits_for_range"})
    return {"tournaments": len(tournaments),
            "tournamentsWithAuthorCredits": len({g["tournamentId"] for g in groups}),
            "authorCreditGroups": len(groups), "coveredQuestionSlots": len(covered),
            "knownCoveredAnswers": len(known), "takenCoveredAnswers": len(taken),
            "fieldExpectedCoveredAnswers": fsum(expectations.values()),
            "allKnownAnswers": total_questions,
            "singletonQuestionRanges": singleton_ranges,
            "overlaps": overlaps, "ambiguousCredits": ambiguous,
            "unmatchedCreditNames": dict(unmatched), "groups": groups}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    bundle = json.loads((args.root / "data/dashboard.json").read_text(encoding="utf-8"))
    tournaments = bundle["tournaments"]
    result = {
        "schemaVersion": 1,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "sourceSnapshotAt": bundle["fetchedAt"],
        "sourceBuiltAt": bundle.get("builtAt"),
        "teamId": bundle["team"]["id"],
        "status": "range_credits_available_question_authorship_unresolved",
        "semantics": {
            "source": "https://api.rating.chgk.info/docs.jsonopenapi",
            "schema": "Tournament-read_tournament.credits",
            "questions": "Первый и последний вопрос группы; null — весь пакет",
            "tour": "Номер тура пакета; null — редакторы всего пакета или вопросы вне туров",
            "players": "Все кандидаты на одного человека, если имя подходит двум-трём тёзкам и ни один не подтверждён",
            "interpretation": "Авторы перечислены в титрах диапазона. Это не сопоставление конкретного вопроса с конкретным автором.",
            "fieldExpectation": "Сумма долей взятий среди опубликованных соперников, исключая команду 100321. Знаменатель определяется для каждого вопроса по известным отметкам 0/1; снятые вопросы не учитываются.",
            "displayLabel": "Авторские группы по титрам",
            "caveat": "Титры рейтинга могут содержать ошибки автоматического распознавания; имена с unmatched и tentative требуют проверки."
        },
        "investigation": [
            {"url": "https://api.rating.chgk.info/docs.jsonopenapi", "result": "public_schema_checked", "detail": "Отдельного публичного endpoint с метаданными авторства каждого вопроса нет."},
            {"url": "https://api.rating.chgk.info/tournaments/11189/credits/review", "result": "401_token_required", "detail": "Закрытый endpoint не используется."},
            {"url": "https://api.rating.chgk.info/tournaments/11189/packet_files", "result": "token_required_per_schema", "detail": "Содержимое пакетов не скачивалось."},
            {"url": "https://gotquestions.online/", "result": "separate_question_level_enrichment", "detail": "Точные сопоставления сыгранных вопросов сохраняются отдельно в data/played-questions.json; здесь анализируются только титры рейтинга."},
        ],
        "included": audit([t for t in tournaments if t.get("included")]),
        "allRegistered": audit(tournaments)
    }
    path = args.root / "data/authors-data.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = result["included"]
    print(json.dumps({"output": str(path), "tournamentsWithAuthorCredits": counts["tournamentsWithAuthorCredits"],
                      "groups": counts["authorCreditGroups"], "knownCoveredAnswers": counts["knownCoveredAnswers"],
                      "singletonQuestionRanges": len(counts["singletonQuestionRanges"]),
                      "overlapCount": len(counts["overlaps"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
