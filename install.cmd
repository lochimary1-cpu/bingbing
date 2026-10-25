@echo off
rem ===========================================================
rem  bingbing one-click installer.
rem
rem  Filename is deliberately ASCII: a Chinese filename inside a
rem  zip gets mangled by Windows Explorer's extractor on some
rem  systems, which drops the .cmd extension and makes Windows
rem  show the "How do you want to open this file?" dialog.
rem
rem  This file also cd's to its own folder first, so the current
rem  directory does not matter.
rem ===========================================================
setlocal
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
echo   (DeepSeek Harness also ships one, see HOW-TO-INSTALL.txt)
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
