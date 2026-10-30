@echo off
title ProctorShield Node.js Backend Server
echo ========================================================
echo Starting Smart Proctoring Node.js Backend Server...
echo Host: http://localhost:5000
echo ========================================================
cd /d "%~dp0"
node src/index.js
pause

