@echo off
title WA KPPN Pekalongan - Server
echo ================================================
echo   WA KPPN Pekalongan - Starting Application
echo ================================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js first from https://nodejs.org
    echo.
    pause
    exit /b
)

echo [OK] Node.js detected.
echo.
echo Starting server...
echo.

:: Start the server
node server.js

echo.
echo Server stopped.
pause