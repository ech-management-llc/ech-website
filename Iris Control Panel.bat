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

REM The panel opens your browser itself, from inside the server's start-up callback.
REM
REM This used to be a blind 3-second wait here in the .bat. If Node took longer than that -
REM cold disk, slow machine, antivirus inspecting node.exe - Chrome hit a dead port and showed
REM "127.0.0.1 refused to connect", which looks like the panel is broken when it is merely
REM slow. Node knows the exact moment the port is listening; cmd does not. So Node does it.

echo   Panel starting. LEAVE THIS WINDOW OPEN.
echo   Closing this window stops the panel.
echo.

node tools\iris-panel.js

echo.
echo   ==========================================================
echo    Panel stopped.
echo.
echo    If you did not press Ctrl+C, read the message above -
echo    it says why. The panel does not run in the background;
echo    it lives in this window.
echo   ==========================================================
pause
