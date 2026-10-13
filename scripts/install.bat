@echo off
rem ShopLedger setup (CLAUDE.md section 18). Double-click it once after copying
rem the ShopLedger folder to this laptop. It:
rem   1. checks Node.js 24 or newer is installed,
rem   2. installs the parts ShopLedger needs (only if they are missing),
rem   3. creates the data folder and brings the database up to date,
rem   4. adds a "ShopLedger" shortcut to the desktop and to Startup.
rem   install.bat /test   does steps 1-3 only, without pausing (used by the release test).
setlocal
cd /d "%~dp0.."
set "TESTMODE="
if /i "%~1"=="/test" set "TESTMODE=1"

echo.
echo === ShopLedger setup ===
echo Folder: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install "Node.js 24 LTS" for Windows from https://nodejs.org, then run this again.
  goto :fail
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo ShopLedger needs Node.js 24 or newer. Install "Node.js 24 LTS" from https://nodejs.org, then run this again.
  goto :fail
)

rem The release normally carries its parts with it; install them only if they are missing or do not load.
node -e "new (require('better-sqlite3'))(':memory:').close()" >nul 2>nul
if errorlevel 1 (
  echo Installing the parts ShopLedger needs. This needs the internet once and takes a few minutes...
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Installing failed. Check the internet connection and run this again.
    goto :fail
  )
) else (
  echo The parts ShopLedger needs are already installed.
)

call node scripts\run-cli.mjs migrate
if errorlevel 1 (
  echo The database could not be prepared. See the message above.
  goto :fail
)

if defined TESTMODE goto :done

set "APPDIR=%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = New-Object -ComObject WScript.Shell; foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'))) { $l = $s.CreateShortcut((Join-Path $d 'ShopLedger.lnk')); $l.TargetPath = (Join-Path $env:APPDIR 'scripts\start.bat'); $l.WorkingDirectory = $env:APPDIR; $l.WindowStyle = 7; $l.Description = 'Start ShopLedger'; $l.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',43'; $l.Save() }"
if errorlevel 1 (
  echo The shortcuts could not be created. You can start ShopLedger with scripts\start.bat instead.
) else (
  echo Added a "ShopLedger" shortcut to the desktop, and to Startup so it opens when Windows starts.
)

:done
echo.
echo ShopLedger is ready. Start it with the ShopLedger shortcut on the desktop.
echo The first time, it asks you to create the superuser and then the owner account.
if not defined TESTMODE pause
exit /b 0

:fail
echo.
if not defined TESTMODE pause
exit /b 1
