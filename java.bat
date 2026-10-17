@echo off
REM java.bat - forwarder: resolve current JDK via 'jenv getjava', run java.exe
setlocal enabledelayedexpansion

set "JENV_BAT=%~dp0jenv.bat"
set "var="
for /f "usebackq delims=" %%i in (`call "%JENV_BAT%" getjava`) do set "var=%%i"

if exist "%var%\bin\java.exe" (
    "%var%\bin\java.exe" %*
) else (
    echo There was an error:
    echo %var%
)
endlocal
