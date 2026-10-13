@echo off
rem Starts ShopLedger and opens it in the browser. If it is already running,
rem it just opens the browser. Keep this window open (it can be minimised);
rem press Ctrl+C here, or close the window, to stop ShopLedger.
title ShopLedger - keep this window open
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install "Node.js 24 LTS" from https://nodejs.org, then run scripts\install.bat.
  pause
  exit /b 1
)
set "NODE_ENV=production"
rem A small young-generation heap keeps idle memory near 110 MB instead of 230 MB (CLAUDE.md: under 200 MB).
echo ShopLedger is running. Leave this window open; you can minimise it.
echo To stop ShopLedger, press Ctrl+C in this window or close it.
node --max-semi-space-size=2 apps\server\dist\server.js --open
if errorlevel 1 (
  echo.
  echo ShopLedger stopped because of a problem. The details are in the data\logs folder.
  pause
)
