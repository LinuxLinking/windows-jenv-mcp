@echo off
REM jenv-getjava.bat - resolve the current JAVA_HOME path
REM Priority: JENVUSE (session var) > local (dir binding) > global (config)
REM Prints exactly one line to stdout (consumed by java.bat via for /f).

setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"

REM 1. Session override (set by 'jenv use', current cmd session level)
if defined JENVUSE (
    if not "!JENVUSE!"=="" (
        echo !JENVUSE!
        exit /b 0
    )
)

REM 2. Local: current dir (%CD%) -> locals.txt name -> jenvs.txt path
set "LNAME="
if exist "%JENV_APPDATA%\locals.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
        if /i "%%b"=="!CD!" set "LNAME=%%a"
    )
)
if defined LNAME (
    if not "!LNAME!"=="" (
        set "LPATH="
        if exist "%JENV_APPDATA%\jenvs.txt" (
            for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
                if /i "%%a"=="!LNAME!" set "LPATH=%%b"
            )
        )
        if defined LPATH (
            if not "!LPATH!"=="" (
                echo !LPATH!
                exit /b 0
            )
        )
    )
)

REM 3. Global config
if exist "%JENV_APPDATA%\global.txt" (
    set "GVAL="
    for /f "usebackq delims=" %%g in ("%JENV_APPDATA%\global.txt") do (
        if not "%%g"=="" set "GVAL=%%g"
    )
    if defined GVAL (
        if not "!GVAL!"=="" (
            echo !GVAL!
            exit /b 0
        )
    )
)

REM 4. Nothing set
echo No global java version found. Use jenv change to set one
exit /b 0
