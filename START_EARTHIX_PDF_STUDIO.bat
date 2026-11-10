@echo off
setlocal
cd /d "%~dp0"
title Earthix PDF Studio

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 20.19+ or 22.12+ from https://nodejs.org/
  pause
  exit /b 1
)

node -e "const [major,minor] = process.versions.node.split('.').map(Number); if (major < 20 || (major === 20 && minor < 19) || (major === 22 && minor < 12) || major === 21) process.exit(1)"
if errorlevel 1 (
  echo Unsupported Node.js version. Detected version:
  node -v
  echo Use Node.js 20.19+ or 22.12+.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm included.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing Earthix PDF Studio dependencies...
  call npm install
  if errorlevel 1 goto :error
) else (
  if not exist "frontend\node_modules" if not exist "node_modules\react" (
    echo Dependencies appear incomplete. Running npm install...
    call npm install
    if errorlevel 1 goto :error
  )
)

echo Preparing PDF worker and WASM assets...
call npm run prepare:assets
if errorlevel 1 goto :error

echo.
echo Building the fast version of Earthix PDF Studio...
call npm run build
if errorlevel 1 goto :error

echo.
echo Starting Earthix PDF Studio at http://localhost:5173
start "" http://localhost:5173
call npm run preview --workspace @earthix/frontend -- --port 5173
exit /b 0

:error
echo.
echo Setup failed. Check your internet connection and the npm error above.
pause
exit /b 1
