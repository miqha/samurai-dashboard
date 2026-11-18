@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0scripts\windows-launch.cmd" update
exit /b %ERRORLEVEL%
