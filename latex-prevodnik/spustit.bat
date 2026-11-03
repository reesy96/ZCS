@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 spustit.py %*
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python neni nainstalovany. Stahni ho z https://www.python.org/downloads/ ^(zaskrtni "Add python.exe to PATH"^).
    pause
    exit /b 1
  )
  python spustit.py %*
)
pause
