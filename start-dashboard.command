#!/bin/zsh
cd -- "${0:A:h}"
for dashboard_python in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /usr/bin/python3; do
  if "$dashboard_python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    exec "$dashboard_python" scripts/serve.py --open
  fi
done
print 'Для дашборда нужен Python 3.10 или новее: https://www.python.org/downloads/macos/'
read -k 1 '?Нажмите любую клавишу, чтобы закрыть окно.'
exit 1
