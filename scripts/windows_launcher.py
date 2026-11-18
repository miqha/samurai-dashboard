"""Fixed Windows entry points with a readable UTF-8 console and local log.

The .cmd files select a supported Python interpreter. This helper has no third
party dependencies and can also be invoked directly from a different folder.
"""

from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import os
from pathlib import Path
import runpy
import sys
import threading
import traceback

ROOT = Path(__file__).resolve().parents[1]
MODES = {
    "serve": ("serve.py", ["--open"]),
    "update": ("update_dashboard.py", []),
}


class Mirror:
    """Keep console output and the saved log identical, including Cyrillic."""

    def __init__(self, console, log, lock):
        self.console, self.log, self.lock = console, log, lock

    def write(self, text):
        with self.lock:
            self.log.write(text)
            self.log.flush()
            return self.console.write(text)

    def flush(self):
        with self.lock:
            self.log.flush()
            self.console.flush()

    def __getattr__(self, name):
        return getattr(self.console, name)


def launch(mode, *, root=ROOT, script_runner=None):
    if mode not in MODES:
        print("Режим запуска не распознан: используйте start-dashboard.cmd или update-dashboard.cmd.", file=sys.stderr)
        return 2
    if sys.version_info < (3, 10):
        print("Для дашборда нужен Python 3.10 или новее: https://www.python.org/downloads/windows/", file=sys.stderr)
        return 1
    root = Path(root).resolve()
    script, arguments = MODES[mode]
    target = root / "scripts" / script
    if not target.is_file():
        print("Не найден скрипт. Передайте и распакуйте всю папку samurai-dashboard целиком.", file=sys.stderr)
        return 1
    log_path = root / ".updates/windows-launch.log"
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log = log_path.open("a", encoding="utf-8", newline="\n")
    except OSError:
        print("Не удалось записать журнал. Переместите папку дашборда в доступную для записи папку.", file=sys.stderr)
        return 1
    runner = script_runner or runpy.run_path
    old_argv, old_path, old_directory = sys.argv[:], sys.path[:], Path.cwd()
    lock = threading.RLock()
    try:
        with log, redirect_stdout(Mirror(sys.stdout, log, lock)), redirect_stderr(Mirror(sys.stderr, log, lock)):
            print("\n--- " + datetime.now(timezone.utc).isoformat(timespec="seconds") + " · " + mode + " ---", flush=True)
            print("Журнал запуска: " + str(log_path), flush=True)
            os.chdir(root)
            sys.path.insert(0, str(target.parent))
            sys.argv = [str(target), *arguments]
            try:
                runner(str(target), run_name="__main__")
                if mode == "update":
                    print("Обновление завершено. Можно открыть samurai-dashboard.html.", flush=True)
                return 0
            except SystemExit as error:
                if error.code is None:
                    return 0
                if isinstance(error.code, int):
                    return error.code
                print(str(error.code), file=sys.stderr, flush=True)
                return 1
            except KeyboardInterrupt:
                print("\nЗапуск остановлен пользователем.", flush=True)
                return 130
            except Exception:
                print("Не удалось завершить запуск. Подробности записаны в журнале.", file=sys.stderr, flush=True)
                traceback.print_exc()
                return 1
    finally:
        sys.argv, sys.path = old_argv, old_path
        os.chdir(old_directory)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(launch(sys.argv[1] if len(sys.argv) == 2 else ""))
