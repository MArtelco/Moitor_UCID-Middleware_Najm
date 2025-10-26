@echo off
:: =========================================================
:: Avaya one-X Agent API Fix - Batch version
:: Applies registry settings + URLACL for port 60000
:: Must be run as Administrator
:: =========================================================

:: --- Check for admin rights ---
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Requesting administrative privileges...
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo ================================================
echo   Applying Avaya one-X Agent API configuration
echo ================================================
echo.

:: --- 1. Registry: HKCU APIAllowRemoteAccess=1 ---
echo [1/3] Setting HKCU\Software\Avaya\Avaya one-X Agent\Settings...
reg add "HKCU\Software\Avaya\Avaya one-X Agent\Settings" /v APIAllowRemoteAccess /t REG_DWORD /d 1 /f >nul
if %errorLevel%==0 (
  echo     OK: APIAllowRemoteAccess=1 added under HKCU
) else (
  echo     ERROR: could not set HKCU registry key.
)

:: --- 2. Registry: HKLM WOW6432Node MaxWaitToNotify1XAClient=0x4B0 ---
echo [2/3] Setting HKLM\SOFTWARE\WOW6432Node\Avaya\Avaya one-X Agent\Settings\Timers...
reg add "HKLM\SOFTWARE\WOW6432Node\Avaya\Avaya one-X Agent\Settings\Timers" /v MaxWaitToNotify1XAClient /t REG_DWORD /d 1200 /f >nul
if %errorLevel%==0 (
  echo     OK: MaxWaitToNotify1XAClient=1200 added under HKLM
) else (
  echo     ERROR: could not set HKLM registry key.
)

:: --- 3. URL reservation for one-X API ---
echo [3/3] Adding HTTP URL reservation for port 60000...
netsh http add urlacl url=http://*:60000/ user=Everyone >nul 2>&1
if %errorLevel%==0 (
  echo     OK: URL reservation successfully added.
) else (
  echo     NOTE: URL reservation may already exist or need admin rights.
)

echo.
echo ================================================
echo Setup completed. Please restart Avaya one-X Agent
echo ================================================
echo.
pause
exit /b
