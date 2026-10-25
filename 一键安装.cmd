@echo off
rem ===========================================================
rem  bingbing one-click installer (ASCII only - cmd.exe cannot
rem  reliably parse UTF-8 Chinese, so keep this file ASCII).
rem  Double-click it. It cd's to its own folder first, so the
rem  current directory does not matter.
rem ===========================================================
setlocal
rem node prints UTF-8; switch the console so Chinese output is not mojibake
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   bingbing installer
echo   -----------------
echo   folder: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

for /f "delims=" %%v in ('node -v') do echo   node: %%v
echo.

node "%~dp0bin\bingbing.js" install
set CODE=%ERRORLEVEL%
echo.

if "%CODE%"=="0" goto OK

echo   [FAILED] exit code %CODE%
echo   Take a screenshot of the text above and send it back.
goto END

:NONODE
echo   [FAILED] node not found.
echo   Install Node.js 18+ from https://nodejs.org
echo   Or point this file at the node bundled with DSH.
goto END

:OK
echo   [OK] Installed successfully.
echo.
echo   NEXT STEP: quit DeepSeek Harness from the tray icon,
echo   then start it again. A "Jailbreak" button will appear
echo   to the right of the chat input box.

:END
echo.
pause
exit /b %CODE%
