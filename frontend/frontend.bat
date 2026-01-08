@echo off
setlocal
cd /d "%~dp0"

echo === FRONTEND DIR ===
echo %CD%
echo ====================

echo.
echo [1/2] npm install...
call npm install
echo npm install exit code: %ERRORLEVEL%

echo.
echo [2/2] npm run dev...
call npm run dev
echo npm run dev exit code: %ERRORLEVEL%

echo.
echo Frontend script finished (press any key)...
pause >nul
endlocal