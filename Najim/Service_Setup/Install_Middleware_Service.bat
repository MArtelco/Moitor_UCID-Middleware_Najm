@echo off
setlocal

REM ====== Configuration ======
set "APPDIR=C:\Users\Administrator\Downloads\Middleware"
set "SERVICE_NAME=MiddlewareService"
set "EXE=%APPDIR%\middleware.exe"

REM ====== Reinstall service ======
nssm stop "%SERVICE_NAME%" >nul 2>&1
nssm remove "%SERVICE_NAME%" confirm >nul 2>&1

nssm install "%SERVICE_NAME%" "%EXE%"
nssm set "%SERVICE_NAME%" AppDirectory "%APPDIR%"

nssm set "%SERVICE_NAME%" Start SERVICE_AUTO_START
nssm set "%SERVICE_NAME%" Description "Najem Middleware backend service"

echo.
echo Service "%SERVICE_NAME%" installed successfully in:
echo   %APPDIR%
echo.

endlocal
pause
