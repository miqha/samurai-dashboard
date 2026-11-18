#!/usr/bin/env python3
"""Join played Rating questions to public GotQuestions records, conservatively.

Links are exact official gotQuestionsTags or public GotQuestions tIds. Absolute
numbers must be a complete unique 1..N sequence (zero is a warm-up), or explicit
tour/local numbers must exactly match Rating's tour lengths. No title matching.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from dashboard_time import MOSCOW

from gotquestions_public import extract_pack, plain_text, _people
from question_types import classify
from fetch_training_year import unresolved_reference, Pacer
from refresh_http import refresh_payload, refresh_run_id
from training_year_catalog import build_catalog, download_page, search_result, search_url

ROOT = Path(__file__).resolve().parents[1]
VERSION = 1


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    tmp.replace(path)


def discovery_catalog(root, history, refresh=False):
    """Separate history-wide public catalogue; never overwrite the training year."""
    target = root / "data/played-questions-catalog.json"
    if not refresh and target.exists():
        result = read(target)
        if result.get("meta", {}).get("complete") is not True:
            raise ValueError("Incomplete played-question catalogue")
        return result
    if not refresh:
        return read(root / "data/training-year-catalog.json")
    start = min(t["date"][:10] for t in history["tournaments"])
    end = datetime.now(MOSCOW).date().isoformat()
    payloads, total_pages = [], None
    for page in range(1, 102):
        if page > 1:
            time.sleep(1.5)
        payload = download_page(search_url(start, end, page))
        result = search_result(payload)
        payloads.append(payload)
        if total_pages is None:
            total_pages = result["metadata"]["totalPages"]
        if page >= max(1, total_pages + 1):
            break
    result = build_catalog(payloads, start, end, fetched_at=now())
    folder = root / "data/played-question-sources/catalog"
    folder.mkdir(parents=True, exist_ok=True)
    for page, payload in enumerate(payloads, 1):
        (folder / f"page-{page}.html").write_bytes(payload)
        result["meta"]["pages"][page - 1]["sourceFile"] = f"data/played-question-sources/catalog/page-{page}.html"
    write(target, result)
    return result


def valid_cache(path, identifier):
    if not path.exists():
        return None
    try:
        cached = read(path)
        pack = cached["pack"]
        encoded = json.dumps(pack, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        if (pack.get("id") != identifier or pack.get("published") is not True
                or unresolved_reference(pack) or hashlib.sha256(encoded).hexdigest() != cached.get("packSha256")
                or sum(len(t["questions"]) for t in pack["tours"]) != cached.get("sourceQuestionCount")):
            return None
        return cached
    except (OSError, ValueError, KeyError, TypeError):
        return None


def get_pack(root, identifier, refresh=False, refreshed_after=None, pacer=None):
    annual = valid_cache(root / f"data/training-year-sources/packs/{identifier}.json", identifier)
    own_path = root / f"data/played-question-sources/packs/{identifier}.json"
    own = valid_cache(own_path, identifier)
    checked_at = lambda value: value.get("checkedAt", value.get("fetchedAt", ""))
    cached = max((x for x in (annual, own) if x), key=checked_at, default=None)
    run_id = refresh_run_id(root)
    # The updater refreshes the annual archive immediately before this step.
    # Reuse only records retrieved in this run; older matched packs are fetched.
    if cached and (not refresh or (refreshed_after and checked_at(cached) >= refreshed_after
                                  and (not run_id or cached.get("refreshRunId") == run_id))):
        return cached
    if not refresh:
        raise ValueError(f"Missing public pack {identifier}; run --refresh")
    url = f"https://gotquestions.online/pack/{identifier}"
    if cached and cached.get("sourceUrl") != url:
        cached = None
    request = Request(url, headers={"User-Agent": "Samurai-CHGK-Dashboard/4.0 (public played question analysis)", "Accept": "text/html"})
    if pacer:
        pacer.wait()
    try:
        payload, response_validators = refresh_payload(request, cached, urlopen)
    except HTTPError as error:
        if error.code == 429 and pacer:
            pacer.stop(error)
        raise
    checked = now()
    if payload is None:
        cached = {**cached, "checkedAt": checked, "httpValidators": response_validators, "lastHttpStatus": 304,
                  "refreshRunId": run_id}
        write(own_path, cached)
        return cached
    pack = extract_pack(payload.decode("utf-8"), expected_id=identifier)
    if pack.get("published") is not True:
        raise ValueError("Pack is not public")
    cached = {"formatVersion": 2, "sourceUrl": url, "fetchedAt": checked,
              "checkedAt": checked, "httpValidators": response_validators, "lastHttpStatus": 200,
              "refreshRunId": run_id,
              "htmlSha256": hashlib.sha256(payload).hexdigest(),
              "sourceQuestionCount": sum(len(t["questions"]) for t in pack["tours"]),
              "packSha256": hashlib.sha256(json.dumps(pack, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest(), "pack": pack}
    write(own_path, cached)
    return cached


def integer(value):
    if type(value) is int:
        return value
    if isinstance(value, str) and re.fullmatch(r"\d+", value.strip()):
        return int(value)
    return None



def publication_date(value):
    """Preserve an actual timezone-aware pubDate, never a retrieval date."""
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value):
        return None
    if int(value[11:13]) > 23 or int(value[14:16]) > 59 or int(value[17:19]) > 59:
        return None
    offset = re.search(r"[+-](\d{2}):(\d{2})$", value)
    if offset and (int(offset[1]) > 23 or int(offset[2]) > 59):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            return None
    except ValueError:
        return None
    return value


def map_questions(tournament, pack):
    """Return (absolute position, raw question, source tour), or fail closed."""
    n = tournament["totalQuestions"]
    tours = pack.get("tours", [])
    # Explicitly named tie-break / reserve tours are not positions in the main
    # Rating mask. Require a complete 1..N main sequence after this exclusion;
    # never remove an unnamed extra tour just to make the numbers fit.
    supplementary = re.compile(r"\b(?:перестрелк[а-я]*|запасн[а-я]*|дополнительн[а-я]*|разминк[а-я]*)\b", re.I)
    excluded_tours = [tour for tour in tours if supplementary.search(plain_text(tour.get("title")))]
    if excluded_tours:
        tours = [tour for tour in tours if tour not in excluded_tours]
    rows = [(integer(q.get("number")), q, tour) for tour in tours for q in tour.get("questions", [])]
    identifiers = [q.get("id") for _, q, _ in rows]
    if any(type(qid) is not int or qid < 1 for qid in identifiers) or len(set(identifiers)) != len(identifiers):
        return None, "invalid_or_duplicate_source_question_id"
    if any(number is None or number < 0 for number, _, _ in rows):
        return None, "non_numeric_source_numbering"
    positive = [row for row in rows if row[0] > 0]
    numbers = [row[0] for row in positive]
    if len(positive) == n and sorted(numbers) == list(range(1, n + 1)):
        return sorted(positive, key=lambda row: row[0]), "exact_absolute_numbers_1_to_N_excluding_explicit_supplementary_tours" if excluded_tours else "exact_absolute_numbers_1_to_N"
    # A local-number mapping is allowed only with explicit unique source tours,
    # matching every official tour length. Array adjacency is never sufficient.
    active = [tour for tour in tours if any(integer(q.get("number")) != 0 for q in tour.get("questions", []))]
    tour_numbers = [integer(tour.get("number")) for tour in active]
    qty = tournament.get("questionQty", [])
    if len(active) != len(qty) or sorted(tour_numbers, key=lambda x: -1 if x is None else x) != list(range(1, len(qty) + 1)):
        return None, "source_and_rating_question_counts_or_tours_differ"
    mapped, offset = [], 0
    for tour in sorted(active, key=lambda t: integer(t["number"])):
        size = qty[integer(tour["number"]) - 1]
        questions = [(integer(q.get("number")), q, tour) for q in tour["questions"] if integer(q.get("number")) != 0]
        if sorted(row[0] for row in questions) != list(range(1, size + 1)):
            return None, "ambiguous_local_question_numbers"
        mapped.extend((offset + number, q, source_tour) for number, q, source_tour in sorted(questions, key=lambda row: row[0]))
        offset += size
    return mapped, "exact_tour_and_local_numbers"



def build(root, history, catalog, refresh=False, refreshed_after=None):
    bridge = read(root / "data/gotquestions.json")
    official = {row["tournamentId"]: row.get("packetIds", []) for row in bridge.get("tournaments", [])}
    source_links = {}
    for pack in catalog["packages"]:
        for tournament_id in pack.get("tIds", []):
            source_links.setdefault(tournament_id, set()).add(pack["id"])
    rows, statuses, loaded = [], [], {}
    included = [t for t in history["tournaments"] if t.get("included")]
    needed = sorted({p for t in included for p in set(official.get(t["id"], [])) | source_links.get(t["id"], set())})
    pacer = Pacer(root=root)
    # Fresh annual hits return immediately; pace only real network requests.
    # Three workers hide response latency with at most two starts per second.
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(get_pack, root, identifier, refresh, refreshed_after, pacer): identifier for identifier in needed}
        for index, future in enumerate(as_completed(futures), 1):
            identifier = futures[future]
            try:
                loaded[identifier] = future.result()
            except Exception:
                pacer.stopped.set()
                for pending in futures:
                    pending.cancel()
                raise
            if index % 10 == 0 or index == len(needed):
                print(f"Played questions: public pack {index}/{len(needed)}", flush=True)
    for t in included:
        ids = sorted(set(official.get(t["id"], [])) | source_links.get(t["id"], set()))
        candidates, failures = [], []
        for identifier in ids:
            cached = loaded[identifier]
            pack = cached["pack"]
            link = "official_gotQuestionsTags" if identifier in official.get(t["id"], []) else "gotquestions_published_rating_tIds"
            if link != "official_gotQuestionsTags" and t["id"] not in pack.get("tIds", []):
                failures.append({"packageId": identifier, "reason": "catalog_and_pack_rating_links_disagree"})
                continue
            mapping, method = map_questions(t, pack)
            if mapping:
                candidates.append((identifier, cached, mapping, method, link))
            else:
                failures.append({"packageId": identifier, "reason": method})
        status = {"tournamentId": t["id"], "name": t["name"], "questionCount": t["totalQuestions"], "packageIds": ids, "failures": failures}
        if len(candidates) != 1:
            status.update(status="ambiguous" if len(candidates) > 1 else "unmatched", reason="multiple_verified_packets" if len(candidates) > 1 else "no_exact_question_mapping" if ids else "no_published_rating_packet_link", matchedQuestions=0)
            statuses.append(status)
            continue
        identifier, cached, mapped, method, link = candidates[0]
        status.update(status="matched", packageId=identifier, mapping=method, link=link, matchedQuestions=len(mapped),
                      publishedAt=publication_date(cached["pack"].get("pubDate")))
        statuses.append(status)
        for position, q, tour in mapped:
            classes = classify(q)
            rows.append({"tournamentId": t["id"], "number": position, "questionId": q["id"], "packageId": identifier,
                         "sourceNumber": q["number"], "sourceTour": tour.get("number"), "sourceUrl": f"https://gotquestions.online/question/{q['id']}",
                         "authors": _people(q.get("authors")),
                         **classes, "provenance": {"mapping": method, "link": link, "fetchedAt": cached["fetchedAt"], "checkedAt": cached.get("checkedAt", cached["fetchedAt"]), "sourceHtmlSha256": cached["htmlSha256"], "sourcePackSha256": cached["packSha256"]}})
    return {"schemaVersion": VERSION, "builtAt": now(), "sourceSnapshotAt": history["fetchedAt"], "sourceBuiltAt": history["builtAt"],
            "sourceCutoff": history["cutoff"], "sourceHistorySha256": hashlib.sha256((root / "data/dashboard.json").read_bytes()).hexdigest(),
            "sourceBridgeSha256": hashlib.sha256((root / "data/gotquestions.json").read_bytes()).hexdigest(),
            "teamId": history["team"]["id"], "complete": True,
            "catalogFetchedAt": catalog["meta"]["fetchedAt"], "questions": rows, "tournaments": statuses,
            "coverage": {"publishedGames": len(included), "matchedGames": sum(s["status"] == "matched" for s in statuses),
                         "publishedQuestions": sum(t["totalQuestions"] for t in included), "matchedQuestions": len(rows),
                         "unmatchedGames": sum(s["status"] == "unmatched" for s in statuses), "ambiguousGames": sum(s["status"] == "ambiguous" for s in statuses),
                         "loadedPackages": len(loaded),
                         "matchedGamesWithPublicationDate": sum(s["status"] == "matched" and s.get("publishedAt") is not None for s in statuses)},
            "methodology": [
                "Дата публикации пакета — только проверенное поле pubDate самого точно сопоставленного пакета GotQuestions; время скачивания, проверки и порядок каталога не заменяют неизвестную дату.",
                "Сопоставление только по опубликованной связи ID турнира и пакета: официальный gotQuestionsTags или tIds GotQuestions; названия не используются.",
                "Номер вопроса подтверждается полным уникальным рядом 1…N либо точными номерами туров и вопросов. Нулевые разминочные вопросы и явно названные запасные/дополнительные туры и перестрелка исключаются только при полном совпадении основных вопросов. Дуплет/блиц считается одним вопросом рейтинговой маски.",
                "Раздатка определяется по непустым полям razdatkaText, razdatkaPic, razdatkaPicGeneric источника. Отсутствие поля означает «без раздатки в записи».",
                "Формат определяется явным указанием дуплета/блица/тетраблица в начале текста или примечании; смешанные и другие составные форматы выделены отдельно. «Обычный» означает отсутствие такого указания.",
                "Форма ответа определяется явными словесными признаками в тексте, тексте раздатки, примечании и поле form. Категории могут пересекаться; отсутствие признака не доказывает отсутствие ограничения. Для каждой метки сохранены правило и цитата.",
                "Доля поля — средняя доля остальных команд на тех же вопросах, с одинаковым весом каждого вопроса. Это анализ взятия, а не перфоманса B."]}


def publish(root, result):
    write(root / "data/played-questions.json", result)
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    (root / "played-questions-data.js").write_text("window.SAMURAI_PLAYED_QUESTIONS = " + encoded + ";\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    history = read(args.root / "data/dashboard.json")
    # Annual refresh records the start of this run's retrieval, not its end.
    annual = read(args.root / "data/training-year-catalog.json")
    refreshed_after = annual.get("meta", {}).get("fetchedAt") if args.refresh else None
    catalog = discovery_catalog(args.root, history, args.refresh)
    result = build(args.root, history, catalog, args.refresh, refreshed_after)
    publish(args.root, result)
    print(json.dumps(result["coverage"], ensure_ascii=False))


if __name__ == "__main__":
    main()
