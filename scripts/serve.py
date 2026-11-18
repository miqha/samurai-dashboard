#!/usr/bin/env python3
"""Local dashboard and same-origin access to the public tournament catalogue."""
import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import threading
import tempfile
import shutil
import time
import uuid
from urllib.parse import parse_qs, urlsplit
import webbrowser

from fetch_catalog import fetch_catalog, save_catalog
from fetch_gotquestions import build as build_bridge
from fetch_played_questions import build as build_played, publish as publish_played
from fetch_registration_authors import refresh as build_presets
from build_standalone import main as build_standalone
from update_dashboard import UpdateError, run_update, STEPS, _stage, _publish, validate_snapshot

ROOT = Path(__file__).resolve().parents[1]
REFRESH_SECONDS = 15 * 60


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def refresh_catalog_snapshot(root=ROOT, *, bundle=None):
    """Refresh the calendar and every dependent output as one checked snapshot.

    This fast path never downloads question text or refits unchanged history.
    If a new link requires an uncached packet, retain the old complete snapshot
    until the full update downloads it.
    """
    root = Path(root)
    fresh = fetch_catalog() if bundle is None else bundle
    if not valid_bundle(fresh, fresh=True):
        raise ValueError("Каталог получен не полностью")
    parent = root / ".updates/temp"
    parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="catalog-", dir=parent))
    try:
        _stage(root, stage, clear_generated=False)
        save_catalog(fresh, root=stage)
        read = lambda name: json.loads((stage / "data" / name).read_text(encoding="utf-8"))
        history = read("dashboard.json")
        bridge = build_bridge([("data/team-difficulty.json", read("team-difficulty.json")),
                               ("data/catalog.json", fresh)], read("gotquestions-source-status.json"))
        (stage / "data/gotquestions.json").write_text(json.dumps(bridge, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            publish_played(stage, build_played(stage, history, read("played-questions-catalog.json")))
            presets = build_presets(stage)
            build_standalone(stage)
        validate_snapshot(stage, history, history["cutoff"])
        _publish(root, stage, files=["data/catalog.json", "catalog-data.js", "data/gotquestions.json",
                                    "data/played-questions.json", "played-questions-data.js",
                                    "data/registration-training.json", "registration-training.js",
                                    "samurai-dashboard.html"])
        return {**fresh, "_registrationTraining": presets}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def valid_bundle(value, fresh=False):
    if not isinstance(value, dict) or value.get("complete") is not True or not isinstance(value.get("tournaments"), list):
        return False
    if not isinstance(value.get("fetchedAt"), str):
        return False
    try:
        datetime.fromisoformat(value["fetchedAt"].replace("Z", "+00:00"))
        ids = set()
        for row in value["tournaments"]:
            if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] <= 0 or row["id"] in ids:
                return False
            ids.add(row["id"])
            for key in ("dateStart", "dateEnd"):
                if row.get(key) is not None:
                    parsed = datetime.fromisoformat(row[key].replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        return False
        if fresh and (value.get("teamHistoryVerified") is not True or not isinstance(value.get("teamTournamentIds"), list)):
            return False
        if "teamTournamentIds" in value and any(type(identifier) is not int or identifier <= 0 for identifier in value["teamTournamentIds"]):
            return False
    except (ValueError, TypeError, AttributeError):
        return False
    return True


class CatalogStore:
    def __init__(self, root=ROOT, loader=None):
        self.root = Path(root)
        self.loader = loader or (lambda: refresh_catalog_snapshot(root=self.root))
        self.lock = threading.Lock()
        self.checked = 0
        self.error = None
        self.bundle = None
        try:
            saved = json.loads((self.root / "data/catalog.json").read_text(encoding="utf-8"))
            if valid_bundle(saved):
                self.bundle = saved
        except (OSError, ValueError):
            pass

    def get(self, force=False):
        now = time.monotonic()
        # A new process always checks upstream; subsequent reads share a short cache.
        due = not self.checked or now - self.checked >= (15 if force else REFRESH_SECONDS)
        if due and self.lock.acquire(blocking=False):
            try:
                fresh = self.loader()
                if not valid_bundle(fresh, fresh=True):
                    raise ValueError("Каталог получен не полностью")
                self.bundle = fresh
                self.error = None
            except Exception as exc:
                self.error = str(exc)[:300]
            finally:
                self.checked = time.monotonic()
                self.lock.release()
        if self.bundle is None:
            return {"complete": False, "tournaments": [], "_live": {
                "status": "unavailable", "serverTime": timestamp(), "error": self.error}}
        result = dict(self.bundle)
        result["_live"] = {"status": "refreshing" if self.lock.locked() else "stale" if self.error else "fresh",
                           "serverTime": timestamp(), "error": self.error,
                           "refreshAfterSeconds": REFRESH_SECONDS,
                           "historySnapshot": "data/dashboard.json"}
        return result


class UpdateManager:
    """Run one fixed full-update pipeline; HTTP never chooses executable code."""
    def __init__(self, root=ROOT, store=None, runner=run_update):
        self.root = Path(root)
        self.store = store if store is not None else CatalogStore(root=self.root)
        self.runner = runner
        self.lock = threading.Lock()
        self.path = self.root / ".updates" / "job-status.json"
        self.job = None
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(saved, dict) and saved.get("status") in ("running", "completed", "error"):
                self.job = saved
                if self.job["status"] == "running":
                    self.job.update(status="error", finishedAt=timestamp(),
                                    error="Предыдущее обновление прервано. Можно повторить.",
                                    label="Обновление прервано")
                    self._persist()
        except (OSError, ValueError):
            pass

    def _persist(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.job, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.path)

    def read(self):
        with self.lock:
            return dict(self.job) if self.job is not None else None

    def start(self):
        with self.lock:
            if self.job is not None and self.job.get("status") == "running":
                return dict(self.job), False
            self.job = {"id": uuid.uuid4().hex, "status": "running", "step": 0,
                        "total": len(STEPS), "label": "Подготовка обновления", "startedAt": timestamp(),
                        "finishedAt": None, "error": None, "updatedAt": None}
            self._persist()
            initial = dict(self.job)
        threading.Thread(target=self._run, daemon=True).start()
        return initial, True

    def _progress(self, event):
        with self.lock:
            self.job["total"] = max(1, int(event.get("total", self.job["total"])))
            self.job["step"] = max(0, min(self.job["total"], int(event.get("step", self.job["step"]))))
            self.job["label"] = str(event.get("label", "Обновление данных"))[:140]
            self._persist()

    def _run(self):
        try:
            # Auto-refresh and the full updater share the publication lock.
            # Readers keep seeing the previous complete catalogue meanwhile.
            with self.store.lock:
                result = self.runner(root=self.root, report=self._progress)
                saved = json.loads((self.root / "data/catalog.json").read_text(encoding="utf-8"))
                if not valid_bundle(saved, fresh=True):
                    raise ValueError("Updated catalogue is incomplete")
                self.store.bundle = saved
                self.store.error = None
                self.store.checked = time.monotonic()
            with self.lock:
                self.job.update(status="completed", step=self.job["total"], label="Все данные обновлены",
                                finishedAt=timestamp(), updatedAt=(result or {}).get("updatedAt") or timestamp(),
                                elapsedSeconds=(result or {}).get("elapsedSeconds"), stageSeconds=(result or {}).get("stageSeconds"))
                self._persist()
        except Exception as exc:
            with self.lock:
                failed = self.job.get("label", "Обновление данных")
                message = (str(exc) if isinstance(exc, UpdateError) and not exc.snapshot_preserved else
                           "Не удалось завершить обновление: " + failed + ". Сохранён предыдущий снимок.")
                self.job.update(status="error", finishedAt=timestamp(),
                                error=message,
                                snapshotPreserved=not (isinstance(exc, UpdateError) and not exc.snapshot_preserved))
                self._persist()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, store=None, updates=None, **kwargs):
        self.store = store
        self.updates = updates
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _local_request(self):
        hostname = urlsplit("http://" + self.headers.get("Host", "")).hostname
        if hostname not in ("127.0.0.1", "localhost"):
            self.send_error(403, "Local host only")
            return False
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            self.send_error(403, "Local same-origin requests only")
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.send_error(403, "Local same-origin requests only")
            return False
        return True

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_head(self):
        # Runtime state, logs and backups are never browser-served assets.
        target = Path(self.translate_path(self.path)).resolve()
        private = (ROOT / ".updates").resolve()
        if target == private or private in target.parents:
            self.send_error(404)
            return None
        return super().send_head()

    def do_HEAD(self):
        if self._local_request():
            super().do_HEAD()

    def do_POST(self):
        if not self._local_request():
            return
        if self.path != "/api/update":
            self.send_error(404)
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self.send_error(415, "JSON required")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1024:
                raise ValueError("Invalid length")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict) or payload:
                raise ValueError("No command arguments are accepted")
        except (ValueError, UnicodeDecodeError):
            self.send_error(400, "Expected an empty JSON object")
            return
        job, started = self.updates.start()
        self._send_json({"job": job}, 202 if started else 200)

    def do_GET(self):
        if not self._local_request():
            return
        url = urlsplit(self.path)
        if url.path == "/api/update":
            self._send_json({"job": self.updates.read()})
            return
        if url.path == "/api/catalog":
            params = parse_qs(url.query)
            bundle = self.store.get(force=params.get("refresh") == ["1"])
            self._send_json(bundle, 200 if bundle.get("complete") else 503)
            return
        if url.path.startswith("/api/"):
            self.send_error(404)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):
        # Routine asset requests do not need to fill the user's terminal.
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8873)
    parser.add_argument("--open", action="store_true", help="Open the dashboard in the default browser")
    args = parser.parse_args()
    from restore_bootstrap import restore_bootstrap
    restore_bootstrap(ROOT)
    store = CatalogStore()
    updates = UpdateManager(store=store)
    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, store=store, updates=updates))
            break
        except OSError as exc:
            if exc.errno not in (48, 98, 10048):
                raise
    if server is None:
        raise RuntimeError("Не удалось выбрать свободный локальный порт")
    url = "http://127.0.0.1:%d/#play" % server.server_port
    print("Дашборд открыт локально: " + url, flush=True)
    print("Каталог обновляется при открытии и каждые 15 минут. Остановка: Ctrl+C.", flush=True)
    threading.Thread(target=store.get, daemon=True).start()
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nДашборд остановлен.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
