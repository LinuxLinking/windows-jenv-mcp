@echo off
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"

set "NAME=%~1"

if /i "%NAME%"=="--help" goto :help
if /i "%NAME%"=="-h" goto :help

if "%NAME%"=="" (
    echo Missing name. Usage: jenv remove ^<name^>
    goto :eof
)

REM Check whether the name actually exists first. The original always printed success,
REM which hid typos: "jenv remove jdk8e" reported a successful removal of nothing.
set "FOUND="
if exist "%JENV_APPDATA%\jenvs.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
        if /i "%%a"=="!NAME!" set "FOUND=1"
    )
)
if exist "%JENV_APPDATA%\locals.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
        if /i "%%a"=="!NAME!" set "FOUND=1"
    )
)
if not defined FOUND (
    echo Theres no JEnv with name !NAME! Consider using "jenv list"
    goto :eof
)

REM Remove the JEnv entry
if exist "%JENV_APPDATA%\jenvs.txt" (
    set "TMPF=%TEMP%\jenvrm_%RANDOM%.tmp"
    type nul > "!TMPF!"
    set "KEPT="
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
        if /i not "%%a"=="!NAME!" (
            >>"!TMPF!" echo %%a=%%b
            set "KEPT=1"
        )
    )
    move /y "!TMPF!" "%JENV_APPDATA%\jenvs.txt" >nul
)

REM Remove any local binding with that name
if exist "%JENV_APPDATA%\locals.txt" (
    set "TMPF=%TEMP%\jenvlrm_%RANDOM%.tmp"
    type nul > "!TMPF!"
    set "KEPT="
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
        if /i not "%%a"=="!NAME!" (
            >>"!TMPF!" echo %%a=%%b
            set "KEPT=1"
        )
    )
    move /y "!TMPF!" "%JENV_APPDATA%\locals.txt" >nul
)

REM Verified by reading back instead of trusting move: an unverified rewrite that silently
REM failed would leave the entry in place while reporting success.
set "GONE=1"
for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
    if /i "%%a"=="!NAME!" set "GONE="
)
for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
    if /i "%%a"=="!NAME!" set "GONE="
)
if defined GONE (
    echo Your JEnv was removed successfully
) else (
    echo ERROR: could not remove "!NAME!" - the entry is still present.
    goto :eof
)
goto :eof

:help
echo "jenv remove" ^<name^>
echo With this command you can remove any java version you registered with "jenv add"
echo ^<name^> is the alias you asigned to the path with "jenv add ^<name^> ^<path^>"
goto :eof
