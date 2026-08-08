@echo off
setlocal
title H1Emu Nav64 Experimental Setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0scripts\startExperimentalNav64Setup.ps1"
set "NAV64_EXIT=%ERRORLEVEL%"
echo.
if not "%NAV64_EXIT%"=="0" (
  echo Nav64 setup stopped with exit code %NAV64_EXIT%.
  echo Read the error and log path above. Existing QuickStart files were not silently overwritten.
) else (
  echo Nav64 setup finished successfully.
)
echo.
pause
exit /b %NAV64_EXIT%

