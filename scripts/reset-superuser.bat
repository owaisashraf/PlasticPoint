@echo off
rem Sets a new password for the superuser. Works only on this laptop.
cd /d "%~dp0.."
node scripts\run-cli.mjs reset-superuser
pause
