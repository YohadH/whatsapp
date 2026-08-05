@echo off
REM Double-click to run the HeyIL Agent Console with Node (no build needed).
REM Needs Node.js installed. For a standalone .exe instead, run: npm install && npm run build
cd /d "%~dp0"
node console.cjs
pause
