@echo off
rem Checks that the change history (audit log) is complete and untouched.
cd /d "%~dp0.."
node scripts\run-cli.mjs verify-audit
pause
