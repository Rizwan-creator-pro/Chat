@echo off
setlocal
cd /d "%~dp0"
title ApexSender - WhatsApp Multi-Gateway
color 0A

echo ========================================================
echo    ApexSender - WhatsApp Multi-Gateway ^& Parallel Engine
echo ========================================================
echo.

:: Check Node.js installation
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed on this PC!
    echo Please download and install Node.js ^(LTS version^) from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b
)

:: Check if node_modules exists, run npm install if missing
if not exist "node_modules\" (
    echo [SETUP] First-time setup detected. Installing dependencies...
    echo Please wait 15-30 seconds...
    call npm install
    if %errorlevel% neq 0 (
        color 0C
        echo [ERROR] npm install failed. Please check your internet connection.
        pause
        exit /b
    )
    echo [SETUP] Dependencies installed successfully!
    echo.
)

:: Launch the server
echo [STARTING] Launching WhatsApp Gateway Server...
echo [INFO] Dashboard will be available at: http://localhost:3000
echo.

:: Open Dashboard in default browser after 3 seconds in background
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"

:: Start Node.js application
node src/index.js

pause

