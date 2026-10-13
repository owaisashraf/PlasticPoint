@echo off
rem Takes a backup now (safe while ShopLedger is running).
cd /d "%~dp0.."
node scripts\run-cli.mjs backup-now
pause
