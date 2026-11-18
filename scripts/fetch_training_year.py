#!/usr/bin/env python3
"""Fetch every public GotQuestions pack in a verified year catalogue.

Only ordinary public /pack/{id} pages are read. Requests share a conservative
rate limit, and HTTP 429 stops the run without retrying or bypassing the limit.
Every verified pack is cached independently so an interrupted run can resume.
Publication requires all catalogue packs and exact declared question counts.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from gotquestions_public import extract_pack, normalize_pack
from refresh_http import (refresh_payload, refresh_run_id, GQ_MIN_INTERVAL_SECONDS,
                          check_gq_cooldown, record_gq_rate_limit)

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 20_000_000
FORMAT_VERSION = 2


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(path)


def cache_path(root, identifier):
    return root / "data/training-year-sources/packs" / (str(identifier) + ".json")


def validated_cache(path, row):
    try:
        cached = read_json(path)
        pack = cached["pack"]
        version = cached.get("formatVersion")
        if (version not in (1, FORMAT_VERSION) or pack.get("id") != row["id"]
                or pack.get("published") is not True
                or cached.get("sourceUrl") != "https://gotquestions.online/pack/" + str(row["id"])):
            return None
        if version == 1 and unresolved_reference(pack):
            return None
        count = sum(len(t["questions"]) for t in pack["tours"])
        if count != row["questionCount"] or cached.get("sourceQuestionCount") != count:
            return None
        if cached.get("packSha256") != hashlib.sha256(
                json.dumps(pack, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest():
            return None
        return cached
    except (OSError, ValueError, KeyError, TypeError):
        return None


def unresolved_reference(value):
    """Older JSON-only caches must not preserve Next Flight string pointers."""
    if isinstance(value, str):
        return re.fullmatch(r"\$[0-9a-f]+", value) is not None
    if isinstance(value, list):
        return any(unresolved_reference(item) for item in value)
    if isinstance(value, dict):
        return any(unresolved_reference(item) for item in value.values())
    return False


class Pacer:
    def __init__(self, interval=GQ_MIN_INTERVAL_SECONDS, root=None):
        self.interval = interval
        self.root = root
        self.lock = threading.Lock()
        self.next = 0.0
        self.stopped = threading.Event()

    def wait(self):
        if self.root:
            check_gq_cooldown(self.root)
        with self.lock:
            if self.stopped.is_set():
                raise RuntimeError("upstream_rate_limit")
            delay = max(0, self.next - time.monotonic())
            self.next = max(time.monotonic(), self.next) + self.interval
        if self.stopped.wait(delay):
            raise RuntimeError("upstream_rate_limit")

    def stop(self, error):
        self.stopped.set()
        if self.root:
            record_gq_rate_limit(self.root, error)


def fetch_one(root, row, pacer, *, refresh=False, opener=urlopen):
    target = cache_path(root, row["id"])
    cached = validated_cache(target, row)
    if cached is not None and not refresh:
        return cached
    pacer.wait()
    url = "https://gotquestions.online/pack/" + str(row["id"])
    request = Request(url, headers={"User-Agent": "Samurai-CHGK-Dashboard/3.0 (public training archive)",
                                    "Accept": "text/html"})
    try:
        payload, response_validators = refresh_payload(request, cached, opener, limit=MAX_BYTES)
        checked_at = now()
        run_id = refresh_run_id(root)
        if payload is None:
            cached = {**cached, "checkedAt": checked_at, "httpValidators": response_validators,
                      "lastHttpStatus": 304, "refreshRunId": run_id}
            write_json(target, cached)
            return cached
        pack = extract_pack(payload.decode("utf-8"), expected_id=row["id"])
        if pack.get("published") is not True:
            raise ValueError("Pack is not publicly published")
        count = sum(len(t["questions"]) for t in pack["tours"])
        if count != row["questionCount"]:
            raise ValueError(f"Question count mismatch: source {count}, catalogue {row['questionCount']}")
        # The source is a public pack record, not an account/session response.
        # Discard unrelated page content, analytics and the random-question widget.
        cached = {"formatVersion": FORMAT_VERSION, "sourceUrl": url, "fetchedAt": checked_at,
                  "checkedAt": checked_at, "httpValidators": response_validators, "lastHttpStatus": 200,
                  "refreshRunId": run_id,
                  "htmlSha256": hashlib.sha256(payload).hexdigest(), "sourceQuestionCount": count,
                  "packSha256": hashlib.sha256(json.dumps(pack, ensure_ascii=False,
                      sort_keys=True, separators=(",", ":")).encode()).hexdigest(), "pack": pack}
        write_json(target, cached)
        return cached
    except HTTPError as error:
        if error.code == 429:
            pacer.stop(error)
        raise


def validate_catalog(catalog):
    meta, rows = catalog.get("meta", {}), catalog.get("packages")
    if (not isinstance(rows, list) or meta.get("complete") is not True
            or meta.get("terminalEmptyPage") is not True or len(rows) != meta.get("totalResults")):
        raise ValueError("The year catalogue is incomplete")
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate catalogue pack IDs")
    if sum(row["questionCount"] for row in rows) != meta.get("sourceQuestions"):
        raise ValueError("Catalogue question totals disagree")


def build(root, catalog):
    """Build only a complete bank. Never silently substitute the starter archive."""
    validate_catalog(catalog)
    meta = catalog["meta"]
    questions, packages, missing = [], [], []
    for row in catalog["packages"]:
        cached = validated_cache(cache_path(root, row["id"]), row)
        if cached is None:
            missing.append(row["id"])
            continue
        normalized = normalize_pack(cached["pack"], fetched_at=cached["fetchedAt"])
        if len(normalized["questions"]) != row["questionCount"]:
            raise ValueError(f"Normalization lost questions in pack {row['id']}")
        package = normalized["package"]
        package["sourceCheckedAt"] = cached.get("checkedAt", cached["fetchedAt"])
        package["sourceQuestionCount"] = row["questionCount"]
        package["questions"] = len(normalized["questions"])
        packages.append(package)
        for question in normalized["questions"]:
            question["provenance"].update(sourceHtmlSha256=cached["htmlSha256"],
                                          sourcePackSha256=cached["packSha256"])
            questions.append(question)
    if missing:
        raise ValueError(f"Year bank incomplete: {len(missing)} of {len(catalog['packages'])} packs missing")
    if len(questions) != meta["sourceQuestions"] or len({q["id"] for q in questions}) != len(questions):
        raise ValueError("Normalized year bank count or unique question IDs disagree")
    finite = lambda value: isinstance(value, (int, float)) and not isinstance(value, bool)
    coverage = {"questions": len(questions), "packages": len(packages),
                "authors": len({a["id"] for q in questions for a in q["authors"]}),
                "expectedQuestions": meta["sourceQuestions"], "expectedPackages": meta["totalResults"],
                "packagesLoaded": len(packages), "missingPackages": 0,
                "questionsWithDifficulty": sum(finite(q["package"].get("trueDl")) for q in questions),
                "questionsWithoutDifficulty": sum(not finite(q["package"].get("trueDl")) for q in questions),
                "questionsWithMedia": sum(bool(q.get("media")) for q in questions),
                "missingAnswers": sum(bool(q.get("flags", {}).get("missingAnswer")) for q in questions),
                "unavailableForTraining": sum(bool(q.get("flags", {}).get("missingAnswer")) or (
                    not q.get("text") and not any(m.get("role") in ("question", "handout") for m in q.get("media", []))) for q in questions),
                "missingAuthors": sum(not q["authors"] for q in questions),
                "formats": {kind: {"questions": sum(q["package"].get("type") == kind for q in questions),
                                   "packages": sum(p.get("type") == kind for p in packages)}
                            for kind in sorted({str(p.get("type")) for p in packages})}}
    return {"schemaVersion": 2, "meta": {"source": "GotQuestions · полный публичный каталог за последние 12 месяцев",
            "sourceUrl": meta["sourceUrl"], "builtAt": now(), "updatedAt": max(
                (p.get("fetchedAt") or "" for p in packages), default=meta["fetchedAt"]),
            "status": "ready", "complete": True, "yearWindow": {"from": meta["from"],
            "toInclusive": meta["toInclusive"], "dateBasis": meta["dateBasis"]}, "coverage": coverage,
            "catalogFetchedAt": meta["fetchedAt"], "catalogPagination": meta["pages"],
            "sourceCheckedAt": max((p.get("sourceCheckedAt") or "" for p in packages), default=meta["fetchedAt"]),
            "mediaRequiresInternet": True, "limitations": [
                "Границы периода соответствуют публичному фильтру GotQuestions «Сыграно от/до».",
                "Включены все опубликованные вопросы, в том числе с раздатками, нестандартным временем и без trueDL.",
                "Для пакета с несколькими trueDL ориентир взят из турнира с наибольшим числом команд; все исходные значения сохранены.",
                "Медиа хранятся как прямые ссылки на источник; для их просмотра нужен интернет."]},
            "packages": packages, "questions": questions}


def publish(root, bank):
    # Build/validate first, then replace both payload files. The full updater
    # additionally publishes the entire dashboard snapshot transactionally.
    compact = {**bank, "schemaVersion": 3,
               "questions": [{**{key: value for key, value in question.items() if key != "package"},
                               "packageId": question["package"]["id"]} for question in bank["questions"]]}
    encoded = json.dumps(compact, ensure_ascii=False, separators=(",", ":"))
    javascript = "window.SAMURAI_TRAINING_DATA = " + encoded.replace("<", "\\u003c").replace(
        "\u2028", "\\u2028").replace("\u2029", "\\u2029") + ";\n"
    write_json(root / "data/training.json", compact)
    target = root / "training-data.js"
    temporary = target.with_suffix(".js.tmp")
    temporary.write_text(javascript, encoding="utf-8")
    temporary.replace(target)


def download(root, catalog, *, workers=3, refresh=False, interval=GQ_MIN_INTERVAL_SECONDS):
    validate_catalog(catalog)
    pacer = Pacer(interval, root=root)
    rows = catalog["packages"]
    pending = [row for row in rows if refresh or validated_cache(cache_path(root, row["id"]), row) is None]
    print(f"Year catalogue: {len(rows)} packs, {catalog['meta']['sourceQuestions']} questions; downloading {len(pending)}", flush=True)
    errors = []
    with ThreadPoolExecutor(max_workers=max(1, min(3, workers))) as executor:
        futures = {executor.submit(fetch_one, root, row, pacer, refresh=refresh): row for row in pending}
        for count, future in enumerate(as_completed(futures), 1):
            row = futures[future]
            try:
                future.result()
            except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
                code = error.code if isinstance(error, HTTPError) else None
                errors.append({"packId": row["id"], "httpStatus": code, "errorType": type(error).__name__,
                               "message": str(error)[:180]})
                if pacer.stopped.is_set():
                    for item in futures:
                        item.cancel()
                    break
            if count % 20 == 0 or count == len(pending):
                print(f"Downloaded {count}/{len(pending)}; errors {len(errors)}", flush=True)
    checked = [validated_cache(cache_path(root, row["id"]), row) for row in rows]
    run_id = refresh_run_id(root)
    write_json(root / "data/training-year-status.json", {"checkedAt": now(), "catalogPacks": len(rows),
               "cachedPacks": sum(validated_cache(cache_path(root, row["id"]), row) is not None for row in rows),
               "refreshedPacks": sum(bool(value and value.get("checkedAt", value.get("fetchedAt", "")) >= catalog["meta"]["fetchedAt"]) for value in checked),
               "notModifiedPacks": sum(bool(value and value.get("lastHttpStatus") == 304) for value in checked),
               "refreshRunId": run_id,
               "verifiedInRunPacks": sum(bool(value and run_id and value.get("refreshRunId") == run_id) for value in checked),
               "rateLimited": pacer.stopped.is_set(), "errors": errors})
    if errors:
        raise ValueError(f"Could not load {len(errors)} public packs; saved caches can resume this run")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--offline", action="store_true", help="Build from verified saved packs without network")
    parser.add_argument("--refresh", action="store_true", help="Recheck saved packs too")
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    catalog = read_json(args.root / "data/training-year-catalog.json")
    if not args.offline:
        download(args.root, catalog, workers=args.workers, refresh=args.refresh)
    bank = build(args.root, catalog)
    publish(args.root, bank)
    print(json.dumps(bank["meta"]["coverage"], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
