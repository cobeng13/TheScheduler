@echo off
cd /d %~dp0

REM Set PYTHONPATH to backend directory
set PYTHONPATH=%CD%

netstat -ano | findstr /r /c:":8000 .*LISTENING" >nul
if not errorlevel 1 (
  echo WARNING: Port 8000 is already in use. Close the old backend before starting this one.
)

alembic upgrade head
uvicorn app.main:app --reload --port 8000
