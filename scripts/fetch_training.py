#!/usr/bin/env python3
"""Build a small, provenance-preserving training bank from curated public packs.

Default is completely offline: the checked-in original packets and metadata
produce the same questions without contacting GotQuestions. --refresh retrieves
only the exact public source URLs in the manifest, once each, and checks SHA256.
It never searches guessed endpoints or retries a 429. Packet trueDL is not a
question difficulty rating; every exported question retains its packet source.
"""

import argparse
import hashlib
import html
import json
import math
from datetime import datetime, timezone
from pathlib import Path
import re
import unicodedata
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LABEL = re.compile(r"^(Чемпионат|Дата|Тур|Редактор|Инфо|Вопрос\s+\d+|Ответ|Зач[её]т|Незач[её]т|Комментарий|Источник|Автор):\s*$", re.M)
MEDIA = re.compile(r"\((?:pic|aud|vid):|<img\b|<audio\b|<video\b|раздат", re.I)
NONSTANDARD = re.compile(r"\b(?:дуплет|блиц|триплет)\b", re.I)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def finite_dl(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 10


def clean(value):
    """Keep paragraph breaks; publisher line wraps are not question newlines."""
    value = html.unescape(value).replace("\r", "")
    paragraphs = [re.sub(r"[ \t]*\n[ \t]*", " ", part.strip()) for part in re.split(r"\n\s*\n", value.strip())]
    return "\n\n".join(p for p in paragraphs if p)


def text_key(value):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip()


def authors(value):
    # City qualifiers are provenance text, not part of author identity. Splitting
    # happens only outside parentheses; an unresolved group remains a group.
    value = re.sub(r"\([^)]*\)", "", value)
    names = re.split(r",|\s+и\s+", clean(value))
    result = []
    for name in names:
        name = name.strip(" .;\n")
        if name:
            stable = hashlib.sha256(name.encode("utf-8")).hexdigest()[:16]
            result.append({"id": "name:" + stable, "name": name, "identitySource": "published_author_name"})
    return result


def parse_txt(text):
    matches = list(LABEL.finditer(text.replace("\r", "")))
    text = text.replace("\r", "")
    current, tour, items = None, None, []
    for index, match in enumerate(matches):
        key = match[1]
        value = text[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(text)].strip()
        if key == "Тур":
            if current:
                items.append(current)
                current = None
            tour = clean(value)
        elif key.startswith("Вопрос "):
            if current:
                items.append(current)
            current = {"number": int(key.split()[1]), "tour": tour, "text": clean(value)}
        elif current and key in {"Ответ", "Зачет", "Зачёт", "Незачет", "Незачёт", "Комментарий", "Источник", "Автор"}:
            current[key.replace("ё", "е")] = clean(value)
    if current:
        items.append(current)
    # The text format restarts numbering at 1 in each tour. GotQuestions uses
    # packet-wide numbers. Keep the printed number as provenance and assign a
    # unique absolute ordinal for the training question and its identity.
    for ordinal, item in enumerate(items, 1):
        item["printedNumber"] = item["number"]
        item["number"] = ordinal
    return items


def excluded_packet_ids(root, current_time):
    """Exclude known team packets and packets whose published window is open."""
    excluded = set()
    difficulty = read_json(root / "data/team-difficulty.json", {})
    for tournament in difficulty.get("tournaments", []):
        excluded.update(p for p in tournament.get("gotQuestionsTags", []) or [] if isinstance(p, int))
    catalog = read_json(root / "data/catalog.json", {})
    for tournament in catalog.get("tournaments", []):
        try:
            ending = datetime.fromisoformat(tournament.get("dateEnd", "").replace("Z", "+00:00"))
            # Future packets as well as open windows stay outside the bank.
            if ending > current_time:
                excluded.update(p for p in tournament.get("gotQuestionsTags", []) or [] if isinstance(p, int))
        except (TypeError, ValueError):
            continue
    return excluded


def build(root, manifest, current_time=None):
    current_time = current_time or datetime.now(timezone.utc)
    excluded_ids = excluded_packet_ids(root, current_time)
    questions, packages, skipped = [], [], []
    counts = {"unavailableSource": 0, "playedOrOpenPacket": 0, "mediaOrHandout": 0,
              "nonstandardTiming": 0, "missingAuthorOrAnswer": 0, "duplicateText": 0}
    seen_texts = set()
    for package in manifest.get("packages", []):
        packet_id = package.get("id")
        if packet_id in excluded_ids:
            counts["playedOrOpenPacket"] += 1
            skipped.append({"id": packet_id, "reason": "known_team_or_open_packet"})
            continue
        if not finite_dl(package.get("trueDl")):
            raise ValueError(f"Packet {packet_id}: trueDl must be finite and in 0–10")
        if package.get("difficultyEvidenceFile"):
            evidence = read_json(root / "data/training-sources" / package["difficultyEvidenceFile"], {})
            if evidence.get("trueDL") != package["trueDl"] or packet_id not in (evidence.get("gotQuestionsTags") or []):
                raise ValueError(f"Packet {packet_id}: official difficulty/packet evidence mismatch")
        end = datetime.fromisoformat(package["dateEnd"].replace("Z", "+00:00"))
        if end >= current_time:
            counts["playedOrOpenPacket"] += 1
            skipped.append({"id": packet_id, "reason": "packet_window_not_finished"})
            continue
        source = root / "data/training-sources" / package["sourceFile"]
        if not source.exists():
            counts["unavailableSource"] += 1
            skipped.append({"id": packet_id, "reason": "source_cache_missing"})
            continue
        payload = source.read_bytes()
        checksum = hashlib.sha256(payload).hexdigest()
        if checksum != package["sha256"]:
            raise ValueError(f"Packet {packet_id}: source SHA256 mismatch")
        raw = parse_txt(payload.decode(package.get("encoding", "utf-8")))
        if len(raw) != package["sourceQuestionCount"]:
            raise ValueError(f"Packet {packet_id}: expected {package['sourceQuestionCount']} questions, got {len(raw)}")
        exported = 0
        by_number = package.get("questionIds", {})
        id_evidence = read_json(root / "data/training-sources" / package.get("questionIdEvidenceFile", "missing.json"), {})
        id_questions = {q["id"]: q for q in id_evidence.get("questions", [])}
        for item in raw:
            if MEDIA.search(item["text"]):
                counts["mediaOrHandout"] += 1
                continue
            if NONSTANDARD.search(item["text"]):
                counts["nonstandardTiming"] += 1
                continue
            credits = authors(item.get("Автор", ""))
            if not credits or not item.get("Ответ") or not item.get("text"):
                counts["missingAuthorOrAnswer"] += 1
                continue
            key = text_key(item["text"])
            if key in seen_texts:
                counts["duplicateText"] += 1
                continue
            seen_texts.add(key)
            question_id = by_number.get(str(item["number"]))
            if question_id and text_key(id_questions.get(question_id, {}).get("text", "")) != text_key(item["text"]):
                raise ValueError(f"Packet {packet_id}, question {item['number']}: GotQuestions question ID text mismatch")
            packet_url = f"https://gotquestions.online/pack/{packet_id}"
            # The independent question snapshot does not contain packet IDs.
            # An identical text can be reprinted, so it cannot certify that its
            # numerical question ID belongs to this particular GQ packet.
            source_url = packet_url
            packet_meta = {k: package[k] for k in ["id", "name", "trueDl", "dateEnd", "sourcePrecision",
                                                  "difficultySourceUrl", "difficultyCheckedAt", "sourceUrl", "fetchedAt"]}
            packet_meta["url"] = packet_url
            packet_meta["difficultyScope"] = "package"
            packet_meta["ratingTournamentId"] = package.get("ratingTournamentId")
            questions.append({"id": f"gq-pack-{packet_id}-q-{item['number']}", "number": item["number"],
                              "text": item["text"], "answer": item["Ответ"], "acceptedAnswers": [],
                              "acceptedText": item.get("Зачет", ""), "rejectedText": item.get("Незачет", ""),
                              "comment": item.get("Комментарий", ""), "sources": item.get("Источник", ""),
                              "authors": credits, "package": packet_meta, "sourceUrl": source_url,
                              "media": [], "tour": item["tour"], "printedNumber": item["printedNumber"],
                              "provenance": {"textProvider": "public_db_chgk_packet_archive", "textSourceUrl": package["sourceUrl"],
                                             "textSha256": checksum, "gotQuestionsQuestionId": question_id,
                                             "gotQuestionsIdPacketMembershipVerified": False,
                                             "mappingMethod": package["mappingMethod"],
                                             "gotQuestionsIdMethod": "exact_full_question_text" if question_id else None}})
            exported += 1
        packages.append({"id": packet_id, "name": package["name"], "trueDl": package["trueDl"],
                         "questions": exported, "sourceQuestionCount": len(raw), "url": f"https://gotquestions.online/pack/{packet_id}"})
    fetched = [p.get("fetchedAt", "") for p in manifest.get("packages", [])]
    return {"schemaVersion": 1, "meta": {"builtAt": now(), "updatedAt": max(fetched, default=None),
            "source": "Опубликованные пакеты GotQuestions; тексты из открытого архива Базы вопросов ЧГК",
            "sourceUrl": "https://gotquestions.online/", "status": "ready" if questions else "empty",
            "statusMessage": "Вопросы из опубликованных архивных пакетов. trueDL — сложность пакета; зачёт проверяете вы.",
            "directGotQuestions": manifest.get("directGotQuestions"),
            "limitations": ["Каталог является проверенной стартовой подборкой, а не полной базой GotQuestions.",
                "trueDL относится к целому пакету, а не к отдельному вопросу; источник значения и точность сохранены у каждого пакета.",
                "Индивидуальные профили авторов не сопоставлены: авторство сохранено по опубликованным именам.",
                "Вопросы с раздаткой, аудио, картинками и нестандартным временем исключены.",
                "Известные пакеты команды и пакеты с незавершённым окном исключены по доступным метаданным.",
                "Синонимы и формулировки зачёта требуют самопроверки; машинный ответ не заменяет жюри."],
            "coverage": {"questions": len(questions), "packages": len(packages),
                         "authors": len({a['id'] for q in questions for a in q["authors"]}), "excluded": counts},
            "sourceManifest": "data/training-sources/manifest.json", "skippedPackages": skipped},
            "packages": packages, "questions": questions}


def refresh_sources(root, manifest):
    errors = []
    for package in manifest.get("packages", []):
        request = urllib.request.Request(package["sourceUrl"], headers={
            "User-Agent": "Samurai-CHGK-Dashboard/1.0 (curated public training packets)"})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = response.read(8_000_001)
            if len(payload) > 8_000_000:
                raise ValueError("source exceeds 8MB limit")
            if hashlib.sha256(payload).hexdigest() != package["sha256"]:
                raise ValueError("source changed: verify new snapshot before replacing curated packet")
            target = root / "data/training-sources" / package["sourceFile"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            package["fetchedAt"] = now()
        except (urllib.error.URLError, OSError, ValueError, TimeoutError) as error:
            errors.append({"id": package["id"], "error": str(error), "sourceUrl": package["sourceUrl"]})
            if isinstance(error, urllib.error.HTTPError) and error.code == 429:
                break
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--refresh", action="store_true", help="Fetch each curated public source once; default uses checked-in caches")
    parser.add_argument("--refresh-year", action="store_true", help="Refresh the rolling-year public catalogue and all published pack records")
    parser.add_argument("--legacy", action="store_true", help="Explicitly rebuild the original small archive instead of the year bank")
    args = parser.parse_args()
    year_path = args.root / "data/training-year-catalog.json"
    if not args.legacy and (year_path.exists() or args.refresh_year):
        from fetch_training_year import build as build_year, publish as publish_year, download
        if args.refresh_year or args.refresh:
            from dashboard_time import MOSCOW
            from training_year_catalog import create_catalog
            end = datetime.now(MOSCOW).date()
            try:
                start = end.replace(year=end.year - 1)
            except ValueError:
                start = end.replace(year=end.year - 1, day=28)
            catalog = create_catalog(args.root, start.isoformat(), end.isoformat(), refresh=True)
            download(args.root, catalog, refresh=True)
        else:
            catalog = read_json(year_path)
        result = build_year(args.root, catalog)
        publish_year(args.root, result)
        print(json.dumps({"status": "ready", "complete": True,
                          "coverage": result["meta"]["coverage"]}, ensure_ascii=False))
        return 0
    manifest_file = args.root / "data/training-sources/manifest.json"
    manifest = read_json(manifest_file, {})
    errors = refresh_sources(args.root, manifest) if args.refresh else []
    result = build(args.root, manifest)
    if errors:
        result["meta"]["refreshErrors"] = errors
        result["meta"]["statusMessage"] += " Обновление источника не удалось; используется проверенный снимок."
    elif args.refresh:
        write_json(manifest_file, manifest)
    write_json(args.root / "data/training.json", result)
    js = "window.SAMURAI_TRAINING_DATA = " + json.dumps(result, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + ";\n"
    (args.root / "training-data.js").write_text(js, encoding="utf-8")
    print(json.dumps({"status": result["meta"]["status"], "coverage": result["meta"]["coverage"], "errors": errors}, ensure_ascii=False))
    return 0 if result["questions"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
