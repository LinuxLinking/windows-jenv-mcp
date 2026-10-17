@echo off
setlocal enabledelayedexpansion
set "JENV_BAT=%~dp0jenv.bat"
set "var="
for /f "usebackq delims=" %%i in (`call "%JENV_BAT%" getjava`) do set "var=%%i"
if exist "%var%\bin\javac.exe" (
    "%var%\bin\javac.exe" %*
) else (
    echo There was an error:
    echo %var%
)
