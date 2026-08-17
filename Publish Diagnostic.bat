@echo off
REM =====================================================================
REM  Publish Diagnostic
REM
REM  Double-click. It runs the EXACT push the Iris panel runs and shows
REM  the raw git output instead of a summarised error.
REM
REM  It does not change any listing. Worst case it publishes work that
REM  was already waiting to go out - which is what you wanted anyway.
REM
REM  ASCII only in here; the console mangles fancy dashes.
REM =====================================================================

cd /d "%~dp0"

echo.
echo   ================= IRIS PUBLISH DIAGNOSTIC =================
echo.

echo   [1] Who does git think you are?
echo   -----------------------------------------------------------
for /f "delims=" %%a in ('git config user.name 2^>nul')  do echo       user.name  = %%a
for /f "delims=" %%a in ('git config user.email 2^>nul') do echo       user.email = %%a
git config user.email >nul 2>nul
if errorlevel 1 (
  echo       *** NO EMAIL SET. This alone blocks every commit. ***
  echo       Fix: git config --global user.email "jerry.eads@echmanagement.services"
  echo            git config --global user.name  "Jerry Eads"
)
echo.

echo   [2] Which credential helper will supply the password?
echo   -----------------------------------------------------------
for /f "delims=" %%a in ('git config credential.helper 2^>nul') do echo       credential.helper = %%a
git config credential.helper >nul 2>nul
if errorlevel 1 echo       *** NONE CONFIGURED - git has no way to authenticate. ***
echo.

echo   [3] What is waiting to go out?
echo   -----------------------------------------------------------
git status --short
echo.
echo       commits already made but not pushed:
git log --oneline origin/main..HEAD
echo.

echo   [4] Can we reach GitHub at all, with your stored credentials?
echo   -----------------------------------------------------------
echo       (any error text below is the real answer)
echo.
git ls-remote --heads origin main
echo.
echo       exit code above: %errorlevel%
echo.

echo   [5] Commit anything outstanding, then push. Raw output.
echo   -----------------------------------------------------------
git add data/listings.json *.html
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "listings: update via Iris control panel"
) else (
  echo       nothing new to commit - pushing existing commits only
)
echo.
git push origin HEAD
echo.
echo       push exit code: %errorlevel%
echo.

echo   ===========================================================
echo    DONE. Screenshot this whole window and send it over.
echo    The useful part is any red or "fatal:" text above.
echo   ===========================================================
echo.
pause
