@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo Please right-click this file and choose Run as administrator.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure-funnel.ps1"
set "EXITCODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXITCODE%
