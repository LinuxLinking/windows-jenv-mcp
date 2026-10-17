@echo off
REM use: sets current-session JENVUSE + JAVA_HOME (session level, no tmp)
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"

set "NAME=%~1"

if /i "%NAME%"=="--help" goto :help
if /i "%NAME%"=="-h" goto :help

if "%NAME%"=="" (
    echo Missing name. Usage: jenv use ^<name^>
    goto :end
)

REM Remove the session override
if /i "%NAME%"=="remove" (
    endlocal & set "JENVUSE=" & set "JAVA_HOME="
    echo Your session JEnv was unset
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
REM The %JPATH% is expanded at parse time (before endlocal runs), so the values
REM survive endlocal. The trailing echo prints the confirmation message.
endlocal & set "JENVUSE=%JPATH%" & set "JAVA_HOME=%JPATH%" & echo JEnv changed for the current shell session. Careful this overwrites "jenv local"
goto :eof

:help
echo "jenv use ^<name^>"
echo With this command you set your JAVA_HOME and the version of java to be used by your current shell session.
echo ^<name^> is the alias you asigned to the path with "jenv add ^<name^> ^<path^>"
echo Careful this overwrites "jenv local"
goto :eof

:end
endlocal
