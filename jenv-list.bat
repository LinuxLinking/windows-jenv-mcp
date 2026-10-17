@echo off
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"

set "ARG=%~1"
if /i "%ARG%"=="--help" goto :help
if /i "%ARG%"=="-h" goto :help

echo All avaible versions of java
set "HASJ=0"
if exist "%JENV_APPDATA%\jenvs.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
        if not "%%a"=="" (
            set "HASJ=1"
            echo %%a    %%b
        )
    )
)
if "!HASJ!"=="0" echo.

echo.
echo All locally specified versions
set "HASL=0"
if exist "%JENV_APPDATA%\locals.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
        if not "%%a"=="" (
            set "HASL=1"
            echo %%a    %%b
        )
    )
)
if "!HASL!"=="0" echo.
goto :eof

:help
echo "jenv list"
echo This command will display every added java version as well as its name
echo You have to add java versions with "jenv add"
echo Then you can set them with various commands like "jenv use" or "jenv change"
echo This command will also tell you every local JEnv that you specified
echo You can tell JEnv that it should always use jdk8 on the desktop with "jenv local"
goto :eof
