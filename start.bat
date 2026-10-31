@echo off
rem Builds the extension and starts the token server. Keep this window open while trying on.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm start
pause
