@echo off
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"

set "NAME=%~1"

if /i "%NAME%"=="--help" goto :help
if /i "%NAME%"=="-h" goto :help

if "%NAME%"=="" (
    echo Missing name. Usage: jenv local ^<name^>
    goto :eof
)

REM Remove the local JEnv for the current directory
if /i "%NAME%"=="remove" (
    if exist "%JENV_APPDATA%\locals.txt" (
        set "TMPF=%TEMP%\jenvloc_%RANDOM%.tmp"
        type nul > "!TMPF!"
        set "WROTE=0"
        for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
            if /i not "%%b"=="!CD!" (
                >>"!TMPF!" echo %%a=%%b
                set "WROTE=1"
            )
        )
        move /y "!TMPF!" "%JENV_APPDATA%\locals.txt" >nul
    )
    echo Your local JEnv was unset
    goto :eof
)

REM Check if specified JEnv is available
set "JPATH="
if exist "%JENV_APPDATA%\jenvs.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
        if /i "%%a"=="!NAME!" set "JPATH=%%b"
    )
)
if "!JPATH!"=="" (
    echo Theres no JEnv with name !NAME! Consider using "jenv list"
    goto :eof
)

REM Check if path is already used; if so replace the name
set "REPLACED=0"
if exist "%JENV_APPDATA%\locals.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
        if /i "%%b"=="!CD!" set "REPLACED=1"
    )
)
if "!REPLACED!"=="1" (
    REM Rewrite locals: keep every line except current dir, then append new binding
    set "TMPF=%TEMP%\jenvloc_%RANDOM%.tmp"
    type nul > "!TMPF!"
    set "WROTE=0"
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
        if /i not "%%b"=="!CD!" (
            >>"!TMPF!" echo %%a=%%b
            set "WROTE=1"
        )
    )
    >>"!TMPF!" echo !NAME!=!CD!
    move /y "!TMPF!" "%JENV_APPDATA%\locals.txt" >nul
    set "BOUND="
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
        if /i "%%a"=="!NAME!" if /i "%%b"=="!CD!" set "BOUND=1"
    )
    if not defined BOUND (
        echo ERROR: could not rewrite "%JENV_APPDATA%\locals.txt".
        goto :eof
    )
    echo Your replaced your java version for !CD! !NAME!
    goto :eof
)

REM Add new local
REM No trailing backslash inside the quoted path of an existence test - it escapes the
REM closing quote and cmd then reports that the path cannot be found.
if not exist "%JENV_APPDATA%" mkdir "%JENV_APPDATA%" 2>nul
if not exist "%JENV_APPDATA%" (
    echo ERROR: could not create the JEnv registry directory "%JENV_APPDATA%".
    goto :eof
)
>>"!JENV_APPDATA!\locals.txt" echo !NAME!=!CD!
REM Verified by reading locals.txt back rather than via ERRORLEVEL: an echo after a redirect
REM does not reset it, and the redundant mkdir above leaves it at 1. Both the name and the
REM directory are compared, so a truncated write cannot pass as success.
set "BOUND="
for /f "usebackq tokens=1,* delims==" %%a in ("!JENV_APPDATA!\locals.txt") do (
    if /i "%%a"=="!NAME!" if "%%b"=="!CD!" set "BOUND=1"
)
if not defined BOUND (
    echo ERROR: could not write to "!JENV_APPDATA!\locals.txt" - no local binding was created.
    goto :eof
)
echo !CD! is now your local java version for !NAME!
goto :eof

:help
echo "jenv local ^<name^>"
echo This command allows you to specify a java version that will always be used in this folder and all subfolders
echo This is overwriten by "jenv use"
echo ^<name^> is the alias of the JEnv you want to specify
echo Attention! You might have to call jenv first before it changes your JAVA_HOME to the local environment. The java command will work out of the box
goto :eof
