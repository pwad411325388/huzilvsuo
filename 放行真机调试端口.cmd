@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure_lan_firewall.ps1"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
echo.
pause
