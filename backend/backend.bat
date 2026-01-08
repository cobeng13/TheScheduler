@echo off
cd /d %~dp0

REM Set PYTHONPATH to backend directory
set PYTHONPATH=%CD%

alembic upgrade head
uvicorn app.main:app --reload --port 8000