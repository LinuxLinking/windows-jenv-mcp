@echo off
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"
set "JENV_ROOT=%~dp0"
if not "!JENV_ROOT:~-1!"=="" (
    if "!JENV_ROOT:~-1!"=="\" set "JENV_ROOT=!JENV_ROOT:~0,-1!"
)

set "NAME=%~1"

if /i "%NAME%"=="--help" goto :help
if /i "%NAME%"=="-h" goto :help

if "%NAME%"=="" (
    echo Missing name. Usage: jenv uninstall ^<name^>
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

REM Confirmation 1 (default No = abort)
set /p CONFIRM1="Are you sure you want to delete JEnv entirely from this computer? [y/N] "
set "ANS1=%CONFIRM1%"
set "ANS1=!ANS1:~0,1!"
if /i not "!ANS1!"=="y" (
    echo Aborted uninstallation
    goto :eof
)

echo JEnv is changing your environment variables. This could take longer

REM Restore JAVA_HOME to the chosen JDK. Do NOT `set "JAVA_HOME=..."` here: this script
REM runs under setlocal, so a plain assignment is discarded on exit and the caller's shell
REM would keep its old value - the setx below is the only thing that persists. That is
REM also where the original script broke, persisting an undefined variable machine-wide.
net session >nul 2>&1
if errorlevel 1 (
    setx JAVA_HOME "!JPATH!" >nul
    echo ^(Non-admin^) Set user-level JAVA_HOME. New shells will use it.
) else (
    setx JAVA_HOME "!JPATH!" /M >nul
)

REM Add <jpath>\bin to User PATH so 'java' keeps working after uninstall
set "UPATH="
for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v PATH 2^>nul') do set "UPATH=%%b"
if defined UPATH (
    echo !UPATH! | findstr /i /c:"!JPATH!\bin" >nul
    if errorlevel 1 (
        set "NEWPATH=!UPATH!;!JPATH!\bin"
        REM Use reg add (REG_EXPAND_STRING) to avoid setx 1024 truncation
        reg add HKCU\Environment /v PATH /t REG_EXPAND_SZ /d "!NEWPATH!" /f >nul
    )
) else (
    reg add HKCU\Environment /v PATH /t REG_EXPAND_SZ /d "!JPATH!\bin" /f >nul
)

REM Confirmation 2 (default Yes = keep config)
set /p CONFIRM2="Do you want to keep your config file? [Y/n] "
set "ANS2=%CONFIRM2%"
set "ANS2=!ANS2:~0,1!"
if /i "!ANS2!"=="n" (
    rmdir /s /q "%JENV_APPDATA%" 2>nul
)

REM Delete the JEnv folder asynchronously: this script lives inside it, so the removal
REM has to happen after cmd has finished reading this file.
REM Do NOT use `timeout` for the delay. It aborts instantly with "ERROR: Input redirection
REM is not supported" whenever there is no console attached (driven from a script, a pipe,
REM or CI), and because the two commands are joined with `&` the rmdir then fires while
REM this script is still running - leaving the folder behind. `ping` needs no console.
set "SELFROOT=%JENV_ROOT%"
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & rmdir /s /q "%SELFROOT%""

echo Successfully uninstalled JEnv
exit /b 0

:help
echo "jenv uninstall" ^<name^>
echo This command deletes jenv and restores the specified jenv as java
echo ^<name^> is the alias you asigned to the path with "jenv add ^<name^> ^<path^>"
goto :eof
