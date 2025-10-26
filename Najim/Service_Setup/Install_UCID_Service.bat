@echo off
setlocal

REM ====== CORRECT PATHS ======
set "APPDIR=C:\Users\Administrator\Downloads\JAR_UCID"
set "JAVA=C:\Program Files\Eclipse Adoptium\jdk-8.0.462.8-hotspot\bin\java.exe"
set "JAR_FILE=UCID.jar"
set "SERVICE_NAME=UCIDService"

REM ====== (RE)INSTALL SERVICE ======
nssm stop "%SERVICE_NAME%"  >nul 2>&1
nssm remove "%SERVICE_NAME%" confirm >nul 2>&1

nssm install "%SERVICE_NAME%" "%JAVA%"
nssm set "%SERVICE_NAME%" AppDirectory "%APPDIR%"
nssm set "%SERVICE_NAME%" AppParameters "-jar \"%JAR_FILE%\""
nssm set "%SERVICE_NAME%" Start SERVICE_AUTO_START
nssm set "%SERVICE_NAME%" Description "UCID JTAPI Monitor Service"

endlocal
