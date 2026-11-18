#!/usr/bin/env python3
"""Network-free checks for dashboard update jobs and the local update API."""
from email.message import Message
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import serve


def bundle(identifier=201):
    return {
        "complete": True,
        "fetchedAt": "2026-11-09T12:00:00+00:00",
        "tournaments": [{"id": identifier, "dateStart": "2026-11-09T09:00:00+00:00",
                         "dateEnd": "2026-11-15T09:00:00+00:00"}],
        "teamHistoryVerified": True,
        "teamTournamentIds": [101],
    }


def wait_until(predicate, message, timeout=3):
    deadline = time.monotonic() + timeout
    pause = threading.Event()
    while time.monotonic() < deadline:
        if predicate():
            return
        pause.wait(.01)
    raise AssertionError(message)


class MemoryHandler(serve.Handler):
    """Exercise real routing and guards without opening a listening socket."""

    def send_response(self, code, message=None):
        self.response_code = code

    def send_header(self, name, value):
        self.response_headers[name.lower()] = value

    def end_headers(self):
        pass

    def send_error(self, code, message=None, explain=None):
        self.response_code = code
        self.error_message = message


class UpdateManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="samurai-update-test-")
        self.root = Path(self.temporary.name)
        (self.root / "data").mkdir()
        self.save_catalog(bundle())
        self.loader = Mock(side_effect=AssertionError("Unexpected network catalogue load"))
        self.store = serve.CatalogStore(root=self.root, loader=self.loader)

    def tearDown(self):
        self.temporary.cleanup()

    def save_catalog(self, value):
        (self.root / "data/catalog.json").write_text(json.dumps(value), encoding="utf-8")

    def finish(self, manager):
        wait_until(lambda: manager.read().get("status") != "running", "Update worker did not finish")
        return manager.read()

    def test_running_job_exposes_progress_and_duplicate_start_does_not_run_twice(self):
        started = threading.Event()
        release = threading.Event()

        def run(root, report):
            self.assertEqual(root, self.root)
            report({"step": 1, "total": 7, "label": "Проверка данных", "status": "running"})
            started.set()
            if not release.wait(3):
                raise AssertionError("Test did not release update worker")
            return {"updatedAt": "2026-11-09T12:30:00+00:00"}

        runner = Mock(side_effect=run)
        manager = serve.UpdateManager(root=self.root, store=self.store, runner=runner)
        try:
            first, created = manager.start()
            self.assertIs(created, True)
            self.assertTrue(started.wait(2), "Update runner was not started")
            running = manager.read()
            self.assertEqual(running["status"], "running")
            self.assertEqual(running["step"], 1)
            self.assertEqual(running["total"], 7)
            self.assertEqual(running["label"], "Проверка данных")
            duplicate, duplicate_created = manager.start()
            self.assertIs(duplicate_created, False)
            self.assertEqual(first["id"], duplicate["id"])
            self.assertEqual(runner.call_count, 1)
        finally:
            release.set()
            final = self.finish(manager)
        self.assertEqual(final["status"], "completed")
        self.assertIsNone(final["error"])
        self.assertTrue(final["startedAt"])
        self.assertTrue(final["finishedAt"])
        self.assertEqual(final["updatedAt"], "2026-11-09T12:30:00+00:00")
        restored = serve.UpdateManager(root=self.root, store=self.store, runner=Mock()).read()
        self.assertEqual(restored, final)

    def test_success_reloads_catalogue_without_fetching_again(self):
        def run(root, report):
            self.save_catalog(bundle(202))
            return {"updatedAt": "2026-11-09T12:30:00+00:00"}

        manager = serve.UpdateManager(root=self.root, store=self.store, runner=run)
        manager.start()
        self.assertEqual(self.finish(manager)["status"], "completed")
        self.assertEqual(self.store.bundle["tournaments"][0]["id"], 202)
        self.assertIsNone(self.store.error)
        self.assertEqual(self.store.get()["tournaments"][0]["id"], 202)
        self.loader.assert_not_called()

    def test_runner_failure_keeps_previous_catalogue_and_allows_retry(self):
        runner = Mock(side_effect=[RuntimeError("Источник временно недоступен"),
                                   {"updatedAt": "2026-11-09T12:30:00+00:00"}])
        manager = serve.UpdateManager(root=self.root, store=self.store, runner=runner)
        first, _ = manager.start()
        failed = self.finish(manager)
        self.assertEqual(failed["status"], "error")
        self.assertIn("Не удалось завершить обновление", failed["error"])
        self.assertIs(failed["snapshotPreserved"], True)
        self.assertTrue(failed["finishedAt"])
        self.assertEqual(self.store.bundle["tournaments"][0]["id"], 201)
        second, created = manager.start()
        self.assertIs(created, True)
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(self.finish(manager)["status"], "completed")

    def test_failed_snapshot_restoration_never_claims_previous_files_were_preserved(self):
        message = "Не удалось восстановить прежний снимок. Требуется проверить файлы."
        runner = Mock(side_effect=serve.UpdateError(message, snapshot_preserved=False))
        manager = serve.UpdateManager(root=self.root, store=self.store, runner=runner)
        manager.start()
        failed = self.finish(manager)
        self.assertEqual(failed["status"], "error")
        self.assertIs(failed["snapshotPreserved"], False)
        self.assertEqual(failed["error"], message)
        self.assertNotIn("Сохранён предыдущий снимок", failed["error"])
        persisted = json.loads((self.root / ".updates/job-status.json").read_text(encoding="utf-8"))
        self.assertIs(persisted["snapshotPreserved"], False)
        self.assertEqual(persisted["error"], message)

    def test_update_holds_catalogue_lock_to_prevent_concurrent_catalogue_writer(self):
        started = threading.Event()
        release = threading.Event()

        def run(root, report):
            started.set()
            if not release.wait(3):
                raise AssertionError("Test did not release update worker")
            return {"updatedAt": "2026-11-09T12:30:00+00:00"}

        manager = serve.UpdateManager(root=self.root, store=self.store, runner=run)
        manager.start()
        try:
            self.assertTrue(started.wait(2))
            self.assertTrue(self.store.lock.locked())
            during = self.store.get(force=True)
            self.assertEqual(during["_live"]["status"], "refreshing")
            self.assertEqual(during["tournaments"][0]["id"], 201)
            self.loader.assert_not_called()
        finally:
            release.set()
            self.finish(manager)
        self.assertFalse(self.store.lock.locked())

    def test_malformed_catalogue_after_runner_success_is_not_published_as_success(self):
        def run(root, report):
            self.save_catalog({"complete": True, "tournaments": "malformed"})
            return {"updatedAt": "2026-11-09T12:30:00+00:00"}

        manager = serve.UpdateManager(root=self.root, store=self.store, runner=run)
        manager.start()
        result = self.finish(manager)
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["error"])
        self.assertEqual(self.store.bundle["tournaments"][0]["id"], 201)

    def test_interrupted_job_is_restored_as_error_instead_of_running_forever(self):
        path = self.root / ".updates/job-status.json"
        path.parent.mkdir()
        saved = {"id": "interrupted", "status": "running", "step": 1, "total": 2,
                 "label": "Получение данных", "startedAt": "2026-11-09T12:00:00+00:00",
                 "finishedAt": None, "error": None, "updatedAt": None}
        path.write_text(json.dumps(saved), encoding="utf-8")
        runner = Mock()
        manager = serve.UpdateManager(root=self.root, store=self.store, runner=runner)
        restored = manager.read()
        self.assertEqual(restored["id"], "interrupted")
        self.assertEqual(restored["status"], "error")
        self.assertTrue(restored["error"])
        self.assertTrue(restored["finishedAt"])
        persisted = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["status"], "error")
        runner.assert_not_called()


class UpdateAPITests(unittest.TestCase):
    def setUp(self):
        self.manager = Mock()
        self.job = {"id": "local-job", "status": "running", "step": 1, "total": 7,
                    "label": "Загрузка данных", "startedAt": "2026-11-09T12:00:00+00:00",
                    "finishedAt": None, "error": None, "updatedAt": None}
        self.manager.read.return_value = self.job
        self.manager.start.return_value = (self.job, True)
        self.store = Mock()

    def request(self, method="POST", path="/api/update", body=b"{}", headers=None):
        handler = MemoryHandler.__new__(MemoryHandler)
        handler.path = path
        handler.command = method
        handler.headers = Message()
        values = {"Host": "127.0.0.1:8873", "Origin": "http://127.0.0.1:8873",
                  "Content-Type": "application/json", "Content-Length": str(len(body))}
        if headers:
            for key, value in headers.items():
                if value is None:
                    values.pop(key, None)
                else:
                    values[key] = value
        for key, value in values.items():
            handler.headers[key] = value
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.response_code = None
        handler.response_headers = {}
        handler.store = self.store
        handler.updates = self.manager
        handler.directory = str(serve.ROOT)
        getattr(handler, "do_" + method)()
        return handler

    def response_json(self, handler):
        return json.loads(handler.wfile.getvalue())

    def test_get_returns_job_status_and_cannot_start_an_update(self):
        response = self.request(method="GET")
        self.assertEqual(response.response_code, 200)
        self.assertEqual(self.response_json(response), {"job": self.job})
        self.manager.read.assert_called_once_with()
        self.manager.start.assert_not_called()
        self.assertEqual(response.response_headers["cache-control"], "no-store")

    def test_post_starts_fixed_update_job_and_returns_accepted(self):
        response = self.request()
        self.assertEqual(response.response_code, 202)
        self.assertEqual(self.response_json(response), {"job": self.job})
        self.manager.start.assert_called_once_with()
        self.assertEqual(response.response_headers["cache-control"], "no-store")
        self.assertIn("application/json", response.response_headers["content-type"])

    def test_post_returns_existing_job_instead_of_starting_a_duplicate(self):
        self.manager.start.return_value = (self.job, False)
        response = self.request()
        self.assertEqual(response.response_code, 200)
        self.assertEqual(self.response_json(response), {"job": self.job})
        self.manager.start.assert_called_once_with()

    def test_external_hosts_or_origins_cannot_read_or_start_update_jobs(self):
        bad_headers = [{"Host": "evil.example:8873", "Origin": "http://evil.example:8873"},
                       {"Host": "127.0.0.1.evil.example:8873"},
                       {"Host": None},
                       {"Origin": "https://evil.example"},
                       {"Origin": "null"},
                       {"Origin": "http://127.0.0.1:8874"},
                       {"Origin": None, "Sec-Fetch-Site": "cross-site"}]
        for method in ("GET", "POST"):
            for headers in bad_headers:
                with self.subTest(method=method, headers=headers):
                    response = self.request(method=method, headers=headers)
                    self.assertEqual(response.response_code, 403)
        self.manager.start.assert_not_called()
        self.manager.read.assert_not_called()

    def test_localhost_with_matching_origin_is_allowed(self):
        response = self.request(headers={"Host": "localhost:8873", "Origin": "http://localhost:8873"})
        self.assertEqual(response.response_code, 202)

    def test_non_json_requests_are_rejected_before_launching_worker(self):
        for content_type in ("text/plain", "application/x-www-form-urlencoded", None):
            with self.subTest(content_type=content_type):
                response = self.request(headers={"Content-Type": content_type})
                self.assertIn(response.response_code, (400, 415))
        self.manager.start.assert_not_called()

    def test_request_cannot_select_arbitrary_scripts_or_pass_arguments(self):
        for body in (b'{"script":"other.py"}', b'{"command":"unsafe"}',
                     b'{"args":["--anything"]}', b'[]', b'null', b'not-json'):
            with self.subTest(body=body):
                response = self.request(body=body)
                self.assertEqual(response.response_code, 400)
        self.manager.start.assert_not_called()

    def test_invalid_or_oversized_body_length_is_rejected_before_start(self):
        for length in ("-1", "wrong", "999999999"):
            with self.subTest(length=length):
                response = self.request(headers={"Content-Length": length})
                self.assertIn(response.response_code, (400, 413))
        self.manager.start.assert_not_called()

    def test_unknown_api_post_path_cannot_launch_update(self):
        response = self.request(path="/api/run-script")
        self.assertEqual(response.response_code, 404)
        self.manager.start.assert_not_called()

    def test_temporary_update_files_cannot_be_downloaded_with_get_or_head(self):
        paths = ("/.updates", "/.updates/", "/.updates/job-status.json",
                 "/.updates/snapshot-test/data/dashboard.json",
                 "/%2eupdates/job-status.json", "/%2Eupdates%2Fjob-status.json",
                 "/assets/../.updates/job-status.json", "/assets/%2e%2e/.updates/job-status.json",
                 "/.updates/job-status.json?cache=1")
        for method in ("GET", "HEAD"):
            for path in paths:
                with self.subTest(method=method, path=path):
                    response = self.request(method=method, path=path)
                    self.assertEqual(response.response_code, 404)
                    self.assertEqual(response.wfile.getvalue(), b"")
        self.manager.start.assert_not_called()
        self.manager.read.assert_not_called()

    def test_head_rejects_external_host_before_serving_static_files(self):
        for headers in ({"Host": "evil.example", "Origin": None},
                        {"Host": "127.0.0.1.evil.example", "Origin": None},
                        {"Host": None, "Origin": None},
                        {"Origin": "https://evil.example"}):
            with self.subTest(headers=headers):
                response = self.request(method="HEAD", path="/index.html", headers=headers)
                self.assertEqual(response.response_code, 403)
                self.assertEqual(response.wfile.getvalue(), b"")


if __name__ == "__main__":
    unittest.main()
