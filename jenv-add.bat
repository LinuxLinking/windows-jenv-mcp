@echo off
setlocal enabledelayedexpansion
REM Honour a caller-supplied JENV_APPDATA instead of always clobbering it. jenv.bat only
REM defaults this variable, so an explicit override must survive into this script - otherwise
REM jenv.bat creates one directory and this script writes to another.
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"

set "NAME=%~1"
set "PATHARG=%~2"

if /i "%NAME%"=="--help" goto :help
if /i "%NAME%"=="-h" goto :help

if "%NAME%"=="" (
    echo Missing name. Usage: jenv add ^<name^> ^<path^>
    goto :eof
)
if "%PATHARG%"=="" (
    echo Missing path. Usage: jenv add ^<name^> ^<path^>
    goto :eof
)

REM Name cannot be remove
if /i "%NAME%"=="remove" (
    echo Your JEnv name cannot be "remove". Checkout "jenv remove"
    goto :eof
)

REM Reject names containing characters that break the key=value format (char-by-char).
REM "!" is consumed by delayed expansion, so a name containing it cannot round-trip through
REM the registry untouched - and "jenv list" would then show a name that no lookup command
REM can ever match. A leading ";" makes for /f treat the whole line as a comment, which
REM makes the entry invisible to every lookup and silently defeats the read-back below.
set "BAD=0"
set "I=0"
:chkloop
if "!NAME:~%I%,1!"=="" goto :chkdone
set "C=!NAME:~%I%,1!"
if "!C!"==" " set "BAD=1"
if "!C!"=="=" set "BAD=1"
if "!C!"=="&" set "BAD=1"
if "!C!"=="|" set "BAD=1"
if "!C!"=="<" set "BAD=1"
if "!C!"==">" set "BAD=1"
if "!C!"=="!" set "BAD=1"
if "!C!"==";" set "BAD=1"
set /a I+=1
goto :chkloop
:chkdone
if "!BAD!"=="1" (
    echo Invalid name. Name must not contain spaces, "!", ";" or any of: = ^& ^| ^< ^>
    goto :eof
)

REM Same "!" trap applies to the path. Comparing the delayed form against the percent form
REM catches it in one line: percent expansion keeps "!" intact, delayed expansion eats it.
if not "!PATHARG!"=="%PATHARG%" (
    echo ERROR: the path contains a "!" character, which batch cannot store safely.
    goto :eof
)

REM Check if name already used
set "EXISTS=0"
if exist "%JENV_APPDATA%\jenvs.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
        if /i "%%a"=="!NAME!" set "EXISTS=1"
    )
)
if "!EXISTS!"=="1" (
    echo Theres already a JEnv with the name !NAME!. Consider using "jenv list"
    goto :eof
)

REM Check if the path is a valid java home
if not exist "%PATHARG%\bin\java.exe" (
    echo !PATHARG!/bin/java.exe not found. Your Path is not a valid JAVA_HOME
    goto :eof
)

REM Add new JEnv. The registry directory is created here as well as in jenv.bat, because this
REM script is also runnable on its own (jenv-autoscan calls it directly) and because the mkdir
REM in jenv.bat is silent about failure.
if not exist "!JENV_APPDATA!" mkdir "!JENV_APPDATA!" 2>nul
if not exist "!JENV_APPDATA!" (
    echo ERROR: could not create the JEnv registry directory "!JENV_APPDATA!".
    goto :eof
)
>>"!JENV_APPDATA!\jenvs.txt" echo !NAME!=!PATHARG!
REM Verified by reading it back rather than by checking ERRORLEVEL: an echo after a
REM redirect does not reset ERRORLEVEL, and the redundant mkdir above leaves it at 1.
REM The VALUE is compared too, not just the name - a path mangled by cmd before it ever
REM reached this script would otherwise be written and reported as success.
set "ADDED="
for /f "usebackq tokens=1,* delims==" %%a in ("!JENV_APPDATA!\jenvs.txt") do (
    if /i "%%a"=="!NAME!" if "%%b"=="!PATHARG!" set "ADDED=1"
)
if not defined ADDED (
    echo ERROR: could not write "!NAME!" to "!JENV_APPDATA!\jenvs.txt" - JEnv was NOT added.
    goto :eof
)
echo Successfully added the new JEnv: !NAME!
goto :eof

:help
echo "jenv add" ^<name^> ^<path^>
echo With this command you can tell JEnv which java versions you have installed
echo ^<name^> is an alias you have to give the java version for easier referencing. It cannot be remove
echo ^<path^> is the path to the parent of your bin folder. For example: "C:\Program Files\Java\jdk-17"
echo You have to register your JEnvs first before you can use "jenv change", "jenv use" or "jenv local"
echo List all registered java versions with "jenv list"
echo This command is not used to specify local JEnvs. Use "jenv local" for this approach
goto :eof
