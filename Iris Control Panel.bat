@echo off
REM =====================================================================
REM  Iris - Website Control Panel
REM
REM  Double-click this file. It opens the panel in your browser.
REM  Leave the black window open while you use it; close it when done.
REM
REM  %~dp0 means "the folder this .bat lives in", so it works no matter
REM  where you launch it from. ASCII only in here - the console mangles
REM  fancy dashes into garbage like GCo.
REM =====================================================================

cd /d "%~dp0"

echo.
echo   Starting Iris - Website Control...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   PROBLEM: Node.js is not on your PATH.
  echo   Install it from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "tools\iris-panel.js" (
  echo   PROBLEM: tools\iris-panel.js not found.
  echo   This .bat must stay in the ech-website-live folder.
  echo.
  pause
  exit /b 1
)

REM If it's already running, just open the browser and get out of the way.
netstat -ano | findstr /C:"127.0.0.1:7317" | findstr /C:"LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   Iris is already running - opening your browser.
  echo.
  start "" http://127.0.0.1:7317
  timeout /t 2 >nul
  exit /b 0
)

REM Give the server a couple of seconds, then open the browser.
start "" /min cmd /c "timeout /t 3 >nul & start http://127.0.0.1:7317"

node tools\iris-panel.js

echo.
echo   Panel stopped.
pause
