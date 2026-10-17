@echo off
REM use: sets current-session JENVUSE + JAVA_HOME (session level, no tmp)
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"
REM JENV_ROOT = the jenv proxy dir (where java.bat lives). The session JAVA_HOME
REM points HERE, never at the real JDK (see jenv-change.bat for why). The real
REM JDK path for this session is carried by JENVUSE, which the java.bat shim
REM reads via `jenv getjava` (JENVUSE > local > global). No setx here: `use` is
REM session-scoped, so it must not touch the registry.
set "JENV_ROOT=%~dp0"
if not "!JENV_ROOT:~-1!"=="" if "!JENV_ROOT:~-1!"=="\" set "JENV_ROOT=!JENV_ROOT:~0,-1!"

set "NAME=%~1"

if /i "%NAME%"=="--help" goto :help
if /i "%NAME%"=="-h" goto :help

if "%NAME%"=="" (
    echo Missing name. Usage: jenv use ^<name^>
    goto :end
)

REM Remove the session override. JENVUSE is cleared so the shim falls back to
REM local/global; JAVA_HOME stays pointed at the jenv proxy dir (not the real
REM JDK, and not blank).
if /i "%NAME%"=="remove" (
    endlocal & set "JENVUSE=" & set "JAVA_HOME=%JENV_ROOT%" & echo Your session JEnv was unset
    goto :eof
)

REM Look up path
set "JPATH="
if exist "%JENV_APPDATA%\jenvs.txt" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%JENV_APPDATA%\jenvs.txt") do (
        if /i "%%a"=="!NAME!" set "JPATH=%%b"
    )
)
if "!JPATH!"=="" (
    echo Theres no JEnv with name !NAME! Consider using "jenv list"
    goto :end
)

REM Propagate session env vars back to the parent cmd process.
REM %JPATH% (the real JDK) is expanded at parse time (before endlocal) so it
REM survives endlocal into JENVUSE, where the java.bat shim reads it via
REM `jenv getjava`. %JENV_ROOT% (the proxy dir) likewise becomes the session
REM JAVA_HOME -- never the real JDK. The trailing echo prints the confirmation.
endlocal & set "JENVUSE=%JPATH%" & set "JAVA_HOME=%JENV_ROOT%" & echo JEnv changed for the current shell session. Careful this overwrites "jenv local"
goto :eof

:help
echo "jenv use ^<name^>"
echo With this command you set your JAVA_HOME and the version of java to be used by your current shell session.
echo ^<name^> is the alias you asigned to the path with "jenv add ^<name^> ^<path^>"
echo Careful this overwrites "jenv local"
goto :eof

:end
endlocal
