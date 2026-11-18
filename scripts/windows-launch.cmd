@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONDONTWRITEBYTECODE=1"
pushd "%~dp0.."
if errorlevel 1 goto folder_error

if not "%~1"=="serve" if not "%~1"=="update" goto mode_error
py -3 -c "import sys; raise SystemExit(not sys.version_info >= (3, 10))" >nul 2>&1
if not errorlevel 1 goto use_py
python -c "import sys; raise SystemExit(not sys.version_info >= (3, 10))" >nul 2>&1
if not errorlevel 1 goto use_python
echo Нужен Python 3.10 или новее. Он не найден или установленная версия устарела.
echo Установите Python с https://www.python.org/downloads/windows/
echo При установке включите Python Launcher или Add python.exe to PATH.
echo Затем снова откройте этот файл. Автоматическая установка не выполняется.
set "SAMURAI_EXIT=1"
goto finish

:use_py
py -3 -u "scripts\windows_launcher.py" "%~1"
set "SAMURAI_EXIT=%ERRORLEVEL%"
goto finish

:use_python
python -u "scripts\windows_launcher.py" "%~1"
set "SAMURAI_EXIT=%ERRORLEVEL%"
goto finish

:mode_error
echo Неизвестный режим запуска. Откройте start-dashboard.cmd или update-dashboard.cmd.
set "SAMURAI_EXIT=2"
goto finish

:folder_error
echo Не удалось открыть папку дашборда. Распакуйте всю папку перед запуском.
pause
exit /b 1

:finish
if not "%SAMURAI_EXIT%"=="0" echo Запуск завершился с кодом %SAMURAI_EXIT%. Журнал: .updates\windows-launch.log
popd
echo.
pause
exit /b %SAMURAI_EXIT%
