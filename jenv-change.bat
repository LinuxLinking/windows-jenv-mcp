@echo off
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"
REM JENV_ROOT is the jenv proxy directory (where java.bat lives). Per the
REM architecture, the system JAVA_HOME must point HERE, never at a real JDK:
REM persisting a real JDK path as JAVA_HOME lets tools that read
REM %JAVA_HOME%\bin\java.exe (Gradle, IDEs) bypass jenv's forwarding layer, so
REM `jenv use` / `jenv local` selections stop reaching them. The real JDK path
REM lives only in jenv's own registry (jenvs.txt / global.txt / JENVUSE) and is
REM resolved at call time by `jenv getjava` from the java.bat shim.
set "JENV_ROOT=%~dp0"
if not "!JENV_ROOT:~-1!"=="" if "!JENV_ROOT:~-1!"=="\" set "JENV_ROOT=!JENV_ROOT:~0,-1!"

set "NAME=%~1"

if /i "%NAME%"=="--help" goto :help
if /i "%NAME%"=="-h" goto :help

if "%NAME%"=="" (
    echo Missing name. Usage: jenv change ^<name^>
    goto :eof
)

REM Look up the path for this name
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

echo Setting JAVA_HOME globally. This could take some time

REM Write the global config. This is what `jenv getjava` reads, and therefore what the
REM java.bat / javac.bat forwarders pick up in every new shell. A failed write must NOT be
REM followed by setx and a success message - that would leave the machine pointing at one
REM JDK while the registry says another.
REM Note: no trailing backslash inside the quoted path of an existence test - it escapes the
REM closing quote and cmd then reports that the path cannot be found.
if not exist "%JENV_APPDATA%" mkdir "%JENV_APPDATA%" 2>nul
if not exist "%JENV_APPDATA%" (
    echo ERROR: could not create the JEnv registry directory "%JENV_APPDATA%".
    goto :eof
)
>"%JENV_APPDATA%\global.txt" echo !JPATH!
REM Verified by reading it back rather than via ERRORLEVEL: an echo after a redirect does not
REM reset it, and the redundant mkdir above leaves it at 1.
set "GLOBAL_OK="
if exist "%JENV_APPDATA%\global.txt" for /f "usebackq delims=" %%g in ("%JENV_APPDATA%\global.txt") do (
    if "%%g"=="!JPATH!" set "GLOBAL_OK=1"
)
if not defined GLOBAL_OK (
    echo ERROR: could not write to "%JENV_APPDATA%\global.txt" - nothing was changed.
    goto :eof
)

REM Persist JAVA_HOME for new shells at USER scope. The value is the jenv proxy
REM directory (JENV_ROOT), NOT the real JDK path -- see the note at the top of
REM this file. The original PowerShell version wrote User scope as well. `/M`
REM writes HKLM instead, which demands administrator rights for something that
REM only ever needs to affect the current user - and it also meant the
REM global.txt write above happened before the privilege check, so a non-admin
REM run silently changed the effective JDK and then reported failure.
setx JAVA_HOME "!JENV_ROOT!" >nul

REM Sync the current shell too. The help text promises this applies "globaly for all
REM restarted shells and this one", and the old `set "JAVA_HOME=..."` could not deliver
REM it: this script runs under `setlocal`, so the assignment was discarded on exit.
REM `endlocal & set` is the only way to reach the caller's environment - it works because
REM %JENV_ROOT% is expanded at parse time, before endlocal runs. As in jenv-use.bat, keep this
REM line at top level: wrapping it in parentheses would silently break it.
endlocal & set "JAVA_HOME=%JENV_ROOT%" & echo JEnv changed globally
goto :eof

:help
echo "jenv change ^<name^>"
echo With this command you set your JAVA_HOME and the version of java to be used globally. This is overwriten by both "jenv local" and "jenv use"
echo ^<name^> is the alias you asigned to the path with "jenv add ^<name^> ^<path^>"
goto :eof
