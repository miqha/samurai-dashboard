#!/usr/bin/env python3
"""Refresh all dashboard data in isolation, then publish a verified snapshot.

The local HTTP server calls run_update without forwarding any request arguments.
Only the scripts listed here can run, always through this Python binary
and without a shell. Failed downloads or checks leave the saved dashboard intact.
"""

from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dashboard_time import MOSCOW


ROOT = Path(__file__).resolve().parents[1]
TEAM_ID = 100321
STEPS = (
    ("fetch_data.py", "История выступлений и ответы на вопросы"),
    ("fetch_team_difficulty.py", "Сложность сыгранных турниров"),
    ("fetch_team_intersections.py", "Проверка повторяющихся вопросов"),
    ("fetch_authors.py", "Авторские группы и редакторы"),
    ("fetch_catalog.py", "Актуальные турниры и сроки игры"),
    ("fetch_gotquestions.py", "Сложность trueDL и связи с Got Questions"),
    ("fetch_training.py", "Проверенный каталог вопросов для тренировок"),
    ("fetch_played_questions.py", "Вопросы сыгранных пакетов и их форматы"),
    ("fetch_registration_authors.py", "Авторы турниров из заявок команды"),
    ("build_standalone.py", "Сборка HTML-страницы"),
)
SCRIPT_DEPENDENCIES = ("dashboard_time.py", "rating_http.py", "refresh_http.py", "fetch_training_year.py", "gotquestions_public.py", "question_types.py", "training_year_catalog.py")
GENERATED = (
    "data.js", "team-difficulty.js", "team-intersections.js", "catalog-data.js",
    "samurai-dashboard.html", "data/dashboard.json", "data/team-difficulty.json",
    "data/team-intersections.json", "data/authors-data.json", "data/catalog.json",
    "data/gotquestions.json", "training-data.js", "data/training.json", "data/training-year-catalog.json",
    "data/training-year-status.json",
    "data/gotquestions-source-status.json", "played-questions-data.js", "data/played-questions.json",
    "data/played-questions-catalog.json",
    "registration-training.js", "data/registration-training.json",
)


class UpdateError(RuntimeError):
    """A short, user-facing failure, deliberately excluding upstream output."""

    def __init__(self, message, *, snapshot_preserved=True):
        super().__init__(message)
        self.snapshot_preserved = snapshot_preserved


def _read(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as error:
        raise UpdateError("Новые данные не прошли проверку формата. Прежний снимок сохранён.") from error


def _require(condition, message):
    if not condition:
        raise UpdateError(message + " Прежний снимок сохранён.")


def _ids(rows, key="id"):
    _require(isinstance(rows, list), "Получен неполный список турниров.")
    identifiers = []
    for row in rows:
        _require(isinstance(row, dict) and type(row.get(key)) is int and row[key] > 0,
                 "Получены некорректные идентификаторы турниров.")
        identifiers.append(row[key])
    _require(len(set(identifiers)) == len(identifiers), "В данных повторяются турниры.")
    return set(identifiers)


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _time(value):
    _require(isinstance(value, str), "В данных отсутствует время обновления.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError) as error:
        raise UpdateError("В новых данных некорректная дата. Прежний снимок сохранён.") from error
    _require(parsed.tzinfo is not None, "В новых данных не указан часовой пояс.")
    return parsed


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_derived(stage, history, catalog, training, included):
    """Derived question metadata must describe this exact snapshot."""
    history_hash = _sha256(stage / "data/dashboard.json")
    played = _read(stage / "data/played-questions.json")
    _require(played.get("teamId") == TEAM_ID and played.get("complete") is True
             and played.get("sourceHistorySha256") == history_hash
             and played.get("sourceBridgeSha256") == _sha256(stage / "data/gotquestions.json")
             and _ids(played.get("tournaments"), "tournamentId") == {t["id"] for t in included},
             "Типы вопросов не соответствуют новой истории.")
    _time(played.get("builtAt"))
    played_catalog = _read(stage / "data/played-questions-catalog.json")
    _require(played_catalog.get("meta", {}).get("complete") is True
             and played_catalog.get("meta", {}).get("terminalEmptyPage") is True
             and played.get("catalogFetchedAt") == played_catalog.get("meta", {}).get("fetchedAt"),
             "Поиск сыгранных пакетов не завершён.")
    by_id = {t["id"]: t for t in included}
    seen = set()
    for row in played.get("questions", []):
        tid, number = row.get("tournamentId"), row.get("number")
        key = (tid, number)
        _require(tid in by_id and type(number) is int and 1 <= number <= by_id[tid]["totalQuestions"]
                 and key not in seen and type(row.get("questionId")) is int
                 and type(row.get("packageId")) is int
                 and row.get("handout") in ("with", "without")
                 and row.get("format") in ("ordinary", "duplet", "blitz", "tetra", "other")
                 and isinstance(row.get("forms"), list) and row["forms"],
                 "Некорректно сопоставлены позиции или признаки вопросов.")
        seen.add(key)
    _require(played.get("coverage", {}).get("matchedQuestions") == len(seen),
             "Не совпадает охват типов вопросов.")
    presets = _read(stage / "data/registration-training.json")
    _require(presets.get("teamId") == TEAM_ID
             and _ids(presets.get("tournaments"), "tournamentId") == set(catalog["teamTournamentIds"]),
             "Авторы тренировок не соответствуют заявкам команды.")
    _time(presets.get("builtAt"))
    source_hashes = presets.get("source", {}).get("inputSha256", {})
    for filename in ("data/dashboard.json", "data/catalog.json", "data/training.json"):
        _require(source_hashes.get(filename) == _sha256(stage / filename),
                 "Авторы заявок рассчитаны по устаревшим данным.")
    author_ids = {str(a["id"]) for q in training["questions"] for a in q.get("authors", [])}
    for row in presets["tournaments"]:
        _require(row.get("authorBasis") in ("question_credits", "rating_editors", "unavailable")
                 and all(str(a.get("id")) in author_ids for a in row.get("authors", [])),
                 "Тренировки содержат неподтверждённых авторов.")


def _diagnostic_text(value, stage, limit=2400):
    """Bound public script output and remove paths/accidental credential syntax."""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    value = str(value or "").replace(str(stage), "<staging>")
    value = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    value = re.sub(r"(?i)\b(authorization|api[_-]?key|access[_-]?token|token|password|cookie|secret)"
                   r"(\s*[=:]\s*)[^\s,;]+", r"\1\2[redacted]", value)
    value = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "Bearer [redacted]", value)
    return value[-limit:]


def _save_diagnostic(root, stage, *, step, script, cutoff, error, completed=None, cause=None):
    """Keep a local debugging record after deleting the failed staging tree.

    The HTTP API returns only the short UpdateError. This record contains output
    from our fixed public-statistics scripts and must not be exposed over HTTP.
    Writing diagnostics must never replace the original refresh failure.
    """
    try:
        stdout = getattr(completed, "stdout", None)
        stderr = getattr(completed, "stderr", None)
        if cause is not None:
            stdout = getattr(cause, "stdout", getattr(cause, "output", stdout))
            stderr = getattr(cause, "stderr", stderr)
        metadata = []
        for filename in ("dashboard.json", "team-difficulty.json", "team-intersections.json", "catalog.json"):
            path = stage / "data" / filename
            if not path.is_file():
                continue
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeError):
                continue
            if not isinstance(document, dict):
                continue
            errors = document.get("errors")
            if filename == "dashboard.json":
                errors = document.get("coverage", {}).get("errors")
            if not isinstance(errors, list) or not errors:
                continue
            samples = []
            for item in errors[:20]:
                if not isinstance(item, dict):
                    continue
                sample = {key: item[key] for key in ("id", "tournament", "part", "at")
                          if isinstance(item.get(key), (int, str))}
                sample["error"] = _diagnostic_text(item.get("error"), stage, limit=500)
                http_status = re.search(r"\bHTTP Error\s+(\d{3})\b", sample["error"])
                if http_status:
                    sample["httpStatus"] = int(http_status.group(1))
                samples.append(sample)
            metadata.append({"file": "data/" + filename, "errorCount": len(errors), "errors": samples})
        record = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  "step": step, "total": len(STEPS), "script": script, "cutoff": cutoff,
                  "returncode": getattr(completed, "returncode", getattr(cause, "returncode", None)),
                  "exceptionType": type(cause).__name__ if cause is not None else type(error).__name__,
                  "timeout": isinstance(cause, subprocess.TimeoutExpired),
                  "message": _diagnostic_text(error, stage, limit=500),
                  "stdoutTail": _diagnostic_text(stdout, stage),
                  "stderrTail": _diagnostic_text(stderr, stage), "metadataErrors": metadata}
        target = root / ".updates/last-error.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, target)
    except Exception:
        # A full disk can prevent both publication and diagnostics. Preserve the
        # useful original exception and the existing snapshot in that case.
        pass


def validate_snapshot(stage, previous, cutoff):
    """Reject partial history, mismatched masks and incomplete metadata bundles."""
    stage = Path(stage)
    for name in GENERATED:
        _require((stage / name).is_file() and (stage / name).stat().st_size > 0,
                 "Обновление создало не все файлы.")
    history = _read(stage / "data/dashboard.json")
    _require(isinstance(history, dict) and history.get("team", {}).get("id") == TEAM_ID,
             "Получена история другой команды.")
    _require(history.get("cutoff") == cutoff, "История обновлена не на текущую дату.")
    _time(history.get("fetchedAt"))
    _time(history.get("builtAt"))
    identifiers = _ids(history.get("tournaments"))
    old_ids = _ids(previous.get("tournaments", [])) if previous else set()
    _require(bool(identifiers) and old_ids <= identifiers, "В новой истории отсутствуют ранее загруженные турниры.")
    coverage = history.get("coverage", {})
    _require(isinstance(coverage, dict) and coverage.get("errors") == [] and coverage.get("issues") == [],
             "Источник вернул неполную историю или противоречивые результаты.")
    _require(coverage.get("listedTournaments") == coverage.get("loadedTournaments") == len(identifiers),
             "Загружена только часть истории команды.")
    # Tournament points B are the dashboard's performance measure. Missing B
    # remains allowed for an uncalculated result, but a partial upstream rating
    # response must not erase an already known performance (including zero and
    # results whose bonus was not credited because inRating is false).
    points_by_id = {}
    for row in history["tournaments"]:
        rating = row.get("rating")
        _require(rating is None or isinstance(rating, dict), "Некорректный формат рейтинговых данных.")
        points = rating.get("b") if isinstance(rating, dict) else None
        _require(points is None or (_finite(points) and points >= 0),
                 "В новой истории некорректный турнирный балл B.")
        points_by_id[row["id"]] = points
    for row in previous.get("tournaments", []) if previous else []:
        rating = row.get("rating")
        old_points = rating.get("b") if isinstance(rating, dict) else None
        if row.get("included") is True and _finite(old_points) and old_points >= 0:
            _require(points_by_id.get(row["id"]) is not None,
                     "Источник не вернул ранее известный турнирный балл B.")
    included = [row for row in history["tournaments"] if row.get("included") is True]
    _require(coverage.get("includedTournaments") == len(included), "Не совпадает число сыгранных турниров.")
    for row in included:
        mask, quantity = row.get("mask"), row.get("totalQuestions")
        _require(type(quantity) is int and quantity > 0 and isinstance(mask, str) and len(mask) == quantity,
                 "В одном из турниров неполная маска ответов.")
        canceled = row.get("canceledQuestions", [])
        _require(isinstance(canceled, list) and all(type(n) is int and 1 <= n <= quantity for n in canceled),
                 "Некорректно указаны снятые вопросы.")
        known = [index for index, symbol in enumerate(mask) if symbol in "01" and index + 1 not in canceled]
        _require(row.get("knownQuestions") == len(known)
                 and row.get("maskTaken") == sum(mask[index] == "1" for index in known),
                 "Не совпадают маска ответов и рассчитанная статистика.")
        canceled_taken = sum(mask[n - 1] == "1" for n in set(canceled))
        _require(_finite(row.get("score")) and row["score"] in (mask.count("1"), mask.count("1") - canceled_taken)
                 and row.get("resultsAvailable") is True and not row.get("dataIssues"),
                 "Не совпадают опубликованный счёт и маска ответов.")
        for key in ("fieldRates", "fieldCounts", "fieldSuccesses"):
            _require(isinstance(row.get(key), list) and len(row[key]) == quantity,
                     "В новой истории неполная повопросная статистика.")
        for rate, count, successes in zip(row["fieldRates"], row["fieldCounts"], row["fieldSuccesses"]):
            _require(type(count) is int and type(successes) is int and 0 <= successes <= count
                     and (rate is None or (_finite(rate) and 0 <= rate <= 1)),
                     "В новой истории некорректное взятие поля.")
    for filename in ("team-difficulty.json", "team-intersections.json"):
        bundle = _read(stage / "data" / filename)
        _require(bundle.get("teamId") == TEAM_ID and bundle.get("complete") is True
                 and bundle.get("errors") == [] and _ids(bundle.get("tournaments")) == identifiers,
                 "Метаданные истории получены не полностью.")
        _time(bundle.get("fetchedAt"))
    catalog = _read(stage / "data/catalog.json")
    catalog_ids = _ids(catalog.get("tournaments"))
    pagination = catalog.get("pagination", {})
    pages = pagination.get("pages", [])
    _require(catalog.get("teamId") == TEAM_ID and catalog.get("complete") is True
             and catalog.get("teamHistoryVerified") is True
             and pagination.get("terminalEmptyPage") is True and pages
             and pages[-1].get("count") == 0
             and pagination.get("uniqueTournaments") == len(catalog_ids)
             and [page.get("page") for page in pages] == list(range(1, len(pages) + 1)),
             "Каталог актуальных турниров получен не полностью.")
    _time(catalog.get("fetchedAt"))
    _time(catalog.get("teamHistoryCheckedAt"))
    team_ids = catalog.get("teamTournamentIds")
    _require(isinstance(team_ids, list) and all(type(n) is int and n > 0 for n in team_ids)
             and identifiers <= set(team_ids), "Не подтверждена актуальная история команды.")
    for row in catalog["tournaments"]:
        for key in ("dateStart", "dateEnd"):
            if row.get(key) is not None:
                _time(row[key])
    authors = _read(stage / "data/authors-data.json")
    _require(authors.get("teamId") == TEAM_ID and authors.get("sourceSnapshotAt") == history["fetchedAt"]
             and authors.get("sourceBuiltAt") == history.get("builtAt")
             and authors.get("allRegistered", {}).get("tournaments") == len(identifiers)
             and authors.get("included", {}).get("tournaments") == len(included),
             "Авторская статистика не соответствует новой истории.")
    gotquestions = _read(stage / "data/gotquestions.json")
    bridge_ids = _ids(gotquestions.get("tournaments"), "tournamentId")
    _require(gotquestions.get("status") == "truedl_bridge_available"
             and bridge_ids == identifiers | catalog_ids
             and gotquestions.get("coverage", {}).get("tournaments") == len(bridge_ids),
             "Не завершено обновление сложности и связей Got Questions.")
    training = _read(stage / "data/training.json")
    questions = training.get("questions") if isinstance(training, dict) else None
    _require(isinstance(questions, list), "Некорректный каталог тренировочных вопросов.")
    training_packages = {str(package.get("id")): package for package in training.get("packages", [])
                         if isinstance(package, dict)}
    question_ids = set()
    for question in questions:
        _require(isinstance(question, dict), "Некорректный тренировочный вопрос.")
        package = question.get("package") or training_packages.get(str(question.get("packageId")))
        identifier = str(question.get("id") or "")
        _require(identifier and identifier not in question_ids
                 and isinstance(question.get("text"), str)
                 and (question["text"].strip() or question.get("flags", {}).get("missingQuestionText") is True)
                 and isinstance(question.get("answer"), str)
                 and (question["answer"].strip() or question.get("flags", {}).get("missingAnswer") is True)
                 and isinstance(package, dict) and (package.get("trueDl") is None or _finite(package.get("trueDl"))),
                 "В тренировке отсутствуют корректные данные вопроса или пакета.")
        question_ids.add(identifier)
    year = _read(stage / "data/training-year-catalog.json")
    year_meta, training_meta = year.get("meta", {}), training.get("meta", {})
    download_status = _read(stage / "data/training-year-status.json")
    coverage = training_meta.get("coverage", {})
    _require(year_meta.get("complete") is True and year_meta.get("terminalEmptyPage") is True
             and training_meta.get("complete") is True
             and len(year.get("packages", [])) == year_meta.get("totalResults") == coverage.get("packages")
             and set(training_packages) == {str(package.get("id")) for package in year.get("packages", [])}
             and len(questions) == year_meta.get("sourceQuestions") == coverage.get("expectedQuestions")
             and training_meta.get("yearWindow", {}).get("from") == year_meta.get("from")
             and training_meta.get("yearWindow", {}).get("toInclusive") == year_meta.get("toInclusive"),
             "Годовая база вопросов загружена не полностью.")
    _require(download_status.get("errors") == [] and download_status.get("rateLimited") is False
             and download_status.get("cachedPacks") == download_status.get("catalogPacks") == coverage.get("packages"),
             "Проверка загрузки годовых пакетов не завершена.")
    marker_path = stage / ".refresh-context.json"
    if marker_path.exists():
        marker = _read(marker_path)
        _require(download_status.get("refreshRunId") == marker.get("runId")
                 and download_status.get("verifiedInRunPacks") == coverage.get("packages"),
                 "Не все годовые пакеты проверены в текущем обновлении.")
        started = _time(marker.get("startedAt"))
        for package in training_packages.values():
            _require(_time(package.get("sourceCheckedAt")) >= started,
                     "В годовой базе остались непроверенные пакеты прежнего обновления.")
    validate_derived(stage, history, catalog, training, included)
    # JavaScript and its JSON counterpart must carry the very same payload.
    for javascript, json_name in (("data.js", "dashboard.json"), ("catalog-data.js", "catalog.json"),
                                  ("team-difficulty.js", "team-difficulty.json"),
                                  ("team-intersections.js", "team-intersections.json"),
                                  ("training-data.js", "training.json"),
                                  ("played-questions-data.js", "played-questions.json"),
                                  ("registration-training.js", "registration-training.json")):
        content = (stage / javascript).read_text(encoding="utf-8")
        match = re.search(r"window\.SAMURAI_[A-Z_]+\s*=\s*(\{.*\})\s*;\s*$", content, re.S)
        try:
            decoded = json.loads(match.group(1).replace("<\\/", "</")) if match else None
        except ValueError:
            decoded = None
        _require(decoded == _read(stage / "data" / json_name), "HTML и данные обновлены несогласованно.")
    html = (stage / "samurai-dashboard.html").read_text(encoding="utf-8")
    _require("</html>" in html.lower() and "window.SAMURAI_DATA" in html
             and '<script src="' not in html and '<link rel="stylesheet" href="' not in html,
             "Не удалось собрать автономную HTML-страницу.")


def _stage(root, destination, *, clear_generated=True):
    (destination / "scripts").mkdir(parents=True)
    for filename in [step[0] for step in STEPS] + list(SCRIPT_DEPENDENCIES):
        shutil.copy2(root / "scripts" / filename, destination / "scripts" / filename)
    for pattern in ("*.js", "*.css", "index.html"):
        for source in root.glob(pattern):
            if source.is_file():
                shutil.copy2(source, destination / source.name)
    for name in ("data", "vendor"):
        shutil.copytree(root / name, destination / name)
    cooldown = root / ".updates/gotquestions-cooldown.json"
    if cooldown.exists():
        shutil.copy2(cooldown, destination / ".gq-cooldown.json")
    # All outputs must be produced in this run, not inherited from yesterday.
    for filename in GENERATED if clear_generated else ():
        # Keep a source cooldown across runs; --refresh-probe rechecks reachable
        # observations, but must respect a recent 429 / Retry-After.
        if filename != "data/gotquestions-source-status.json":
            (destination / filename).unlink(missing_ok=True)


def _publish(root, stage, files=None):
    if files is None:
        files = list(GENERATED) + [str(path.relative_to(stage)) for path in (stage / "data/raw").glob("*.json")]
        for directory in ("data/training-year-sources", "data/played-question-sources"):
            files += [str(path.relative_to(stage)) for path in (stage / directory).rglob("*")
                      if path.is_file() and path.suffix in (".json", ".html")]
    backup = stage.parent / (stage.name + "-backup")
    backup.mkdir()
    published = []
    keep_backup = False
    try:
        # Back up the complete commit set before touching the saved snapshot.
        for filename in files:
            target = root / filename
            if target.exists():
                saved = backup / filename
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, saved)
        for filename in files:
            target = root / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage / filename, target)
            published.append(filename)
    except OSError as error:
        rollback_failed = False
        for filename in reversed(published):
            target, saved = root / filename, backup / filename
            try:
                if saved.exists():
                    os.replace(saved, target)
                else:
                    target.unlink(missing_ok=True)
            except OSError:
                # A persistent disk failure must not also delete the recovery
                # copy. Try restoring the remaining files before reporting it.
                rollback_failed = True
        if rollback_failed:
            keep_backup = True
            raise UpdateError("Не удалось завершить сохранение и восстановить все файлы. "
                              "Резервная копия сохранена в .updates/temp.",
                              snapshot_preserved=False) from error
        raise UpdateError("Не удалось сохранить обновление. Прежний снимок восстановлен.") from error
    finally:
        if not keep_backup:
            shutil.rmtree(backup, ignore_errors=True)
    return files


def run_update(root=ROOT, report=None, subprocess_runner=None, now=None, *, parallel=True):
    """Refresh independent sources concurrently, then validate and publish.

    Exactly one Rating stage and one GotQuestions stage may run at a time.
    Source request pacing and cooldowns are preserved. Tests can use the same
    dependency graph serially with parallel=False for deterministic failures.
    """
    root = Path(root).resolve()
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    cutoff = instant.astimezone(MOSCOW).date().isoformat()
    previous_path = root / "data/dashboard.json"
    previous = _read(previous_path) if previous_path.exists() else None
    temporary = root / ".updates/temp"
    temporary.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="snapshot-", dir=temporary))
    runner = subprocess_runner or subprocess.run
    started_clock = time.monotonic()
    current_step, current_script, last_completed, last_cause = 0, None, None, None
    progress_lock = threading.Lock()
    completed_steps, timings = set(), {}
    stopped = threading.Event()

    class StepFailure(UpdateError):
        def __init__(self, number, filename, message, completed=None, cause=None):
            super().__init__(message)
            self.number, self.filename, self.completed, self.cause = number, filename, completed, cause

    def emit(step, label, status):
        with progress_lock:
            if status == "complete" and step < len(STEPS):
                completed_steps.add(step)
            progress = min(len(STEPS), len(completed_steps) + (1 if status == "running" else 0)) if parallel else step
            if step == len(STEPS):
                progress = len(STEPS)
            if report is not None:
                try:
                    report({"step": progress, "total": len(STEPS), "label": label, "status": status})
                except Exception:
                    # Observers never participate in the snapshot transaction.
                    pass

    def execute_step(number):
        if stopped.is_set():
            return
        filename, label = STEPS[number - 1]
        args = [sys.executable, str(stage / "scripts" / filename)]
        if filename == "fetch_data.py":
            args += ["--refresh", "--cutoff", cutoff]
        elif filename == "fetch_team_difficulty.py":
            args += ["--refresh", "--reuse-refreshed-metadata"]
        elif filename == "fetch_team_intersections.py":
            args.append("--refresh")
        elif filename == "fetch_catalog.py":
            args.append("--reuse-refreshed-history")
        elif filename == "fetch_gotquestions.py":
            args += ["--catalog", "data/catalog.json", "--probe-homepage", "--refresh-probe"]
        elif filename == "fetch_training.py":
            args.append("--refresh-year")
        elif filename in ("fetch_played_questions.py", "fetch_registration_authors.py"):
            args.append("--refresh")
        emit(number, label, "running")
        step_clock = time.monotonic()
        try:
            completed = runner(args, cwd=str(stage), shell=False, check=False,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", errors="replace", timeout=45 * 60)
        except (OSError, subprocess.SubprocessError) as error:
            stopped.set()
            raise StepFailure(number, filename, f"Не завершён этап «{label}». Прежний снимок сохранён.", cause=error) from error
        finally:
            with progress_lock:
                timings[filename] = round(time.monotonic() - step_clock, 3)
        if completed.returncode != 0:
            stopped.set()
            raise StepFailure(number, filename, f"Не завершён этап «{label}».", completed=completed)
        emit(number, label, "complete")

    def rating_lane():
        # One Rating process at a time preserves its pacing and 429 cooldown.
        for number in range(1, 6):
            execute_step(number)

    try:
        _stage(root, stage)
        (stage / ".refresh-context.json").write_text(json.dumps({
            "startedAt": instant.astimezone(timezone.utc).isoformat(timespec="seconds"),
            "runId": uuid.uuid4().hex}) + "\n", encoding="utf-8")
        if parallel:
            with ThreadPoolExecutor(max_workers=2) as executor:
                lanes = [executor.submit(rating_lane), executor.submit(execute_step, 7)]
                for lane in as_completed(lanes):
                    lane.result()
            # Join the source lanes before building dependent artifacts.
            for number in (6, 8, 9, 10):
                execute_step(number)
        else:
            for number in range(1, len(STEPS) + 1):
                execute_step(number)
        emit(len(STEPS), "Проверка полноты и согласованности данных", "running")
        validate_snapshot(stage, previous, cutoff)
        emit(len(STEPS), "Сохранение проверенного снимка", "running")
        files = _publish(root, stage)
        emit(len(STEPS), "Все данные обновлены", "complete")
        return {"status": "success", "cutoff": cutoff,
                "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "files": len(files), "steps": len(STEPS),
                "elapsedSeconds": round(time.monotonic() - started_clock, 3),
                "stageSeconds": {filename: timings[filename] for filename, _label in STEPS if filename in timings}}
    except UpdateError as error:
        if isinstance(error, StepFailure):
            current_step, current_script = error.number, error.filename
            last_completed, last_cause = error.completed, error.cause
        _save_diagnostic(root, stage, step=current_step, script=current_script, cutoff=cutoff,
                         error=error, completed=last_completed, cause=last_cause)
        raise
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        _save_diagnostic(root, stage, step=current_step, script=current_script, cutoff=cutoff,
                         error=error, completed=last_completed, cause=error)
        raise UpdateError("Не удалось подготовить полное обновление. Прежний снимок сохранён.") from error
    finally:
        # A source cooldown survives failure even though unverified data never
        # publishes. The next button click must honor the same Retry-After.
        cooldown = stage / ".gq-cooldown.json"
        if cooldown.exists():
            try:
                shutil.copy2(cooldown, root / ".updates/gotquestions-cooldown.json")
            except OSError:
                pass
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    try:
        from restore_bootstrap import restore_bootstrap
        restore_bootstrap(ROOT)
        result = run_update(report=lambda event: print(json.dumps(event, ensure_ascii=False), flush=True))
        print(json.dumps(result, ensure_ascii=False))
    except UpdateError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
