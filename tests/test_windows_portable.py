"""Offline portability checks; these do not pretend to run cmd.exe on macOS."""

from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from dashboard_time import MOSCOW
import windows_launcher


class WindowsPortabilityTests(unittest.TestCase):
    def make_root(self, parent):
        root = Path(parent) / "Тренировки ЧГК с пробелами"
        (root / "scripts").mkdir(parents=True)
        for name in ("serve.py", "update_dashboard.py"):
            (root / "scripts" / name).write_text("# test entry point\n", encoding="utf-8")
        return root.resolve()

    def test_shared_moscow_clock_needs_no_optional_iana_database(self):
        instant = datetime(2026, 11, 16, 21, 10, tzinfo=timezone.utc)
        self.assertEqual(instant.astimezone(MOSCOW).date().isoformat(), "2026-11-17")
        self.assertEqual(MOSCOW.utcoffset(instant), timedelta(hours=3))
        for name in ("update_dashboard.py", "fetch_played_questions.py", "fetch_training.py", "dashboard_time.py"):
            content = (ROOT / "scripts" / name).read_text(encoding="utf-8")
            self.assertNotRegex(content, r"(?:from|import)\s+zoneinfo")

    def test_unicode_space_path_dispatch_and_utf8_log(self):
        with tempfile.TemporaryDirectory() as parent:
            root = self.make_root(parent)
            old_directory, old_argv, old_path = Path.cwd(), sys.argv[:], sys.path[:]
            calls = []

            def runner(path, **kwargs):
                calls.append((path, kwargs, sys.argv[:], Path.cwd(), sys.path[0]))
                print("Обновление: вопросы готовы")
                print("Проверка журнала", file=sys.stderr)

            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = windows_launcher.launch("update", root=root, script_runner=runner)
            self.assertEqual(code, 0)
            target = root / "scripts/update_dashboard.py"
            self.assertEqual(calls, [(str(target), {"run_name": "__main__"}, [str(target)], root, str(root / "scripts"))])
            log = (root / ".updates/windows-launch.log").read_bytes().decode("utf-8")
            self.assertIn("Обновление: вопросы готовы", log)
            self.assertIn("Проверка журнала", log)
            self.assertIn("Обновление завершено", out.getvalue())
            self.assertEqual(Path.cwd(), old_directory)
            self.assertEqual(sys.argv, old_argv)
            self.assertEqual(sys.path, old_path)

    def test_server_opens_browser_and_error_exit_is_preserved(self):
        with tempfile.TemporaryDirectory() as parent:
            root = self.make_root(parent)

            def runner(path, **kwargs):
                self.assertEqual(sys.argv, [str(root / "scripts/serve.py"), "--open"])
                raise SystemExit(7)

            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(windows_launcher.launch("serve", root=root, script_runner=runner), 7)

    def test_exception_is_readable_and_logged(self):
        with tempfile.TemporaryDirectory() as parent:
            root = self.make_root(parent)

            def runner(path, **kwargs):
                raise RuntimeError("Тестовая ошибка сети")

            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                self.assertEqual(windows_launcher.launch("update", root=root, script_runner=runner), 1)
            self.assertIn("Не удалось завершить запуск", err.getvalue())
            self.assertIn("Тестовая ошибка сети", (root / ".updates/windows-launch.log").read_text(encoding="utf-8"))

    def test_missing_or_unsupported_setup_exits_without_running_script(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(windows_launcher.launch("wrong", root=root), 2)
                self.assertEqual(windows_launcher.launch("serve", root=root), 1)
                with patch.object(windows_launcher.sys, "version_info", (3, 9)):
                    self.assertEqual(windows_launcher.launch("serve", root=root), 1)
            self.assertFalse((root / ".updates").exists())

    def test_batch_entry_points_are_relative_and_use_bomless_crlf(self):
        for name, mode in (("start-dashboard.cmd", "serve"), ("update-dashboard.cmd", "update")):
            raw = (ROOT / name).read_bytes()
            content = raw.decode("utf-8")
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
            self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))
            self.assertIn('"%~dp0scripts\\windows-launch.cmd" ' + mode, content)
        raw = (ROOT / "scripts/windows-launch.cmd").read_bytes()
        content = raw.decode("utf-8")
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))
        self.assertIn('pushd "%~dp0.."', content)
        self.assertIn("DisableDelayedExpansion", content)
        self.assertIn("PYTHONUTF8=1", content)
        self.assertIn("PYTHONIOENCODING=utf-8", content)
        self.assertIn("chcp 65001", content)
        self.assertIn("pause", content)
        self.assertIn('py -3 -u "scripts\\windows_launcher.py" "%~1"', content)
        self.assertIn('python -u "scripts\\windows_launcher.py" "%~1"', content)
        self.assertNotIn("pip ", content)
        self.assertNotIn("/Users/", content)
        probes = re.findall(r'^(?:py -3|python) -c "([^"]+)"', content, re.M)
        self.assertEqual(len(probes), 2)
        for probe in probes:
            self.assertEqual(subprocess.run([sys.executable, "-c", probe], capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
