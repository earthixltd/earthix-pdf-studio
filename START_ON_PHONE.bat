@echo off
setlocal
cd /d "%~dp0"
title Earthix PDF Studio - phone access
echo.
echo Keep your phone on the same Wi-Fi as this computer, then open one of these
echo addresses in the phone's browser:
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo    http:%%a:5181
echo.
echo If Windows asks about network access for Node.js, allow it on Private networks.
echo Close this window to stop.
echo.
call npm run dev:phone
