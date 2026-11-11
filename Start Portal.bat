@echo off
title SCM SERVICE PORTAL
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and install it, then run this file again.
  pause
  exit /b 1
)
echo Starting SCM SERVICE PORTAL on http://localhost:3000
echo Keep this window open while people use the portal. Close it to stop.
start "" http://localhost:3000
node server.js
pause
