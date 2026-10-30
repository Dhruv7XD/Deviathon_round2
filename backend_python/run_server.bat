@echo off
title ProctorShield FastAPI Backend Server
echo ========================================================
echo Starting Smart Proctoring FastAPI Backend Server...
echo Host: http://localhost:8000
echo Docs: http://localhost:8000/docs
echo ========================================================
cd /d "%~dp0"
set PYTHONPATH=.
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
pause

