@echo off
REM jenv-config.bat - configuration I/O shared library
REM Subroutines are called via:  call jenv-config.bat :func args...
REM Functions that return a string write it to stdout; caller captures with for /f.
REM Expects %JENV_APPDATA% to be set by the caller (=%APPDATA%\JEnv).

setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"
set "JENV_APPDATA=%JENV_APPDATA%"
set "JENV_ROOT=%JENV_ROOT%"
goto :parse

:parse
set "FUNC=%~1"
if "%FUNC%"=="" goto :eof
shift /1
if /i "%FUNC%"==":find_path"       goto :find_path
if /i "%FUNC%"==":find_local_name" goto :find_local_name
if /i "%FUNC%"==":remove_by_key"  goto :remove_by_key
if /i "%FUNC%"==":major_version"  goto :major_version
goto :eof

REM ----- :find_path <name>  -> echoes the path for a jenv name (empty if none)
:find_path
set "NAME=%~1"
set "FOUND="
if exist "%JENV_APPDATA%\jenvs.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
        if /i "%%a"=="!NAME!" set "FOUND=%%b"
    )
)
echo !FOUND!
goto :end_call

REM ----- :find_local_name <dir>  -> echoes the jenv name bound to a directory (empty if none)
:find_local_name
set "DIR=%~1"
set "FOUNDLN="
if exist "%JENV_APPDATA%\locals.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\locals.txt") do (
        if /i "%%b"=="!DIR!" set "FOUNDLN=%%a"
    )
)
echo !FOUNDLN!
goto :end_call

REM ----- :remove_by_key <file> <key>
REM   Removes every line whose key (text before first '=') matches <key>.
REM   file format: key=value per line.
:remove_by_key
set "FILE=%~1"
set "KEY=%~2"
if not exist "%FILE%" goto :end_call
set "T=%TEMP%\jenvcfg_%RANDOM%.tmp"
> "%T%" echo.
set "WROTE=0"
for /f "usebackq tokens=1,* delims==" %%a in ("%FILE%") do (
    if /i not "%%a"=="!KEY!" (
        >>"%T%" echo %%a=%%b
        set "WROTE=1"
    )
)
if "!WROTE!"=="0" (
    REM nothing kept -> leave file empty (single echo above already wrote empty line)
    > "%T%" echo.
)
move /y "%T%" "%FILE%" >nul
goto :end_call

REM ----- :major_version <javaexe>
REM   Derives the major version from the JDK's `release` file: 1.8.0_281 -> "8",
REM   17.0.2 -> "17". Falls back to "java" when there is no release file, which is
REM   what the caller uses as a suggested name.
REM
REM   This used to shell out to `java -version` and scrape the version string out of the
REM   output. That required walking a string that CONTAINS DOUBLE QUOTES, inside
REM   parenthesised blocks, which cmd cannot do: `if "!CH!"==""" (` is a syntax error,
REM   `for /f ... in ("...\"...")` makes cmd try to execute the line, and a version line
REM   containing `)` (every real one does: `Java(TM) SE Runtime Environment ...`) breaks the
REM   enclosing block. The function failed on every call, so `jenv autoscan` silently named
REM   every JDK it found "java" and then rejected each subsequent one as a duplicate.
REM
REM   The release file is plain ASCII on one line, needs no process, and is what
REM   mcp/server.js readRelease() already uses. Keep the two in step.
:major_version
set "JAVAEXE=%~1"
REM Strip bin\java.exe to get the JAVA_HOME the exe lives in.
set "JHOME=%JAVAEXE:\bin\java.exe=%"
set "RELF=!JHOME!\release"
if not exist "!RELF!" (
    echo java
    goto :end_call
)

REM JAVA_VERSION="11.0.6"  ->  split on the first "=", then drop the quotes.
REM The ("<path>") form of `for /f` means "read this file", so the double quotes inside
REM its contents are just data and cannot break the parse the way they did when this
REM function was reading a `java -version` output line.
set "LINE="
for /f "usebackq tokens=1,* delims==" %%a in ("!RELF!") do (
    if /i "%%a"=="JAVA_VERSION" set "LINE=%%b"
)
if not defined LINE (
    echo java
    goto :end_call
)
set "VSTR=!LINE:"=!"

REM Split on the first dot: 1.8.0_281 -> P1=1 P2=8, 17.0.2 -> P1=17 P2=0.
set "P1="
set "P2="
for /f "tokens=1,2 delims=." %%a in ("!VSTR!") do (
    if not defined P1 set "P1=%%a"
    if not defined P2 set "P2=%%b"
)

REM A leading "1." is the old scheme, where the major version is the second segment
REM (1.8 -> 8). Anything else is already the major version.
set "MAJOR=!P1!"
if "!P1!"=="1" if not "!P2!"=="" set "MAJOR=!P2!"
if "!MAJOR!"=="" set "MAJOR=java"
echo !MAJOR!
goto :end_call

:end_call
endlocal & exit /b 0
