@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0scripts\windows-launch.cmd" serve
exit /b %ERRORLEVEL%
