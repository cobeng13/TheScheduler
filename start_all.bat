@echo off
echo Starting Backend...
start "Backend Server" cmd /k backend\backend.bat

REM Give backend time to initialize
timeout /t 5 >nul

echo Starting Frontend...
start "Frontend Server" cmd /k frontend\frontend.bat
