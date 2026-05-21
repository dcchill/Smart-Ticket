@echo off
setlocal

pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

echo Starting SmartTicket...
echo Admin:  http://localhost:3000/admin
echo Client: http://localhost:3000/client
echo.

node "%~dp0server.js"

echo.
echo SmartTicket stopped.
popd
pause
