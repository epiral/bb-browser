@echo off
echo Starting BB Browser Trace Studio...
echo.
echo [1/2] Starting daemon...
cd /d "%~dp0"
node ..\cli\dist\index.js daemon stop >nul 2>&1
node ..\cli\dist\index.js daemon start
if errorlevel 1 (
    echo ERROR: Daemon failed to start
    pause
    exit /b 1
)
echo Daemon started successfully
echo.
echo [2/2] Starting frontend at http://localhost:3003/
pnpm exec vite --port 3003
echo.
echo Stopping daemon...
node ..\cli\dist\index.js daemon stop
pause
