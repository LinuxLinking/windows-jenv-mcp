@echo off
REM jenv-install.bat - one-time machine setup for the proxy architecture.
REM Establishes the invariant:
REM   - JAVA_HOME (session + HKCU + HKLM) = JENV_ROOT, the jenv proxy dir
REM   - JENV_ROOT is prepended to PATH so `java` hits java.bat (the shim)
REM   - the real JDK path lives only in the jenv registry (%APPDATA%\JEnv)
REM Idempotent: re-running only fixes what drifted. Non-elevated runs fix what
REM they can (User scope, session) and print exact instructions for the rest.
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"
set "JENV_ROOT=%~dp0"
if not "!JENV_ROOT:~-1!"=="" if "!JENV_ROOT:~-1!"=="\" set "JENV_ROOT=!JENV_ROOT:~0,-1!"

set "ARG=%~1"
if /i "%ARG%"=="--help" goto :help
if /i "%ARG%"=="-h" goto :help
if not "%ARG%"=="" (
    echo Unknown option "%ARG%". Usage: jenv install
    goto :eof
)

echo Installing JEnv for this machine...
echo   JEnv dir: !JENV_ROOT!
echo   Registry: !JENV_APPDATA!
echo.

REM 1. Registry dir
if not exist "!JENV_APPDATA!" mkdir "!JENV_APPDATA!" 2>nul
if not exist "!JENV_APPDATA!" (
    echo ERROR: could not create the registry directory "!JENV_APPDATA!".
    goto :eof
)

REM 2. Detect elevation once.
set "ADMIN=0"
net session >nul 2>&1
if not errorlevel 1 set "ADMIN=1"

REM 3. JAVA_HOME at both scopes = JENV_ROOT. Elevated writes machine + user;
REM    non-elevated writes user only and warns about machine below.
set "JH_MACHINE=unknown"
for /f "tokens=2,*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v JAVA_HOME 2^>nul ^| findstr /i "JAVA_HOME"') do set "JH_MACHINE=%%b"
if "%ADMIN%"=="1" (
    setx JAVA_HOME "!JENV_ROOT!" /M >nul
    setx JAVA_HOME "!JENV_ROOT!" >nul
    echo [ok] JAVA_HOME set at machine and user scope.
) else (
    setx JAVA_HOME "!JENV_ROOT!" >nul
    echo [ok] JAVA_HOME set at user scope.
    if /i not "!JH_MACHINE!"=="!JENV_ROOT!" (
        echo [..] system JAVA_HOME is "!JH_MACHINE!". Run this once as Administrator to set it too.
    )
)

REM 4. Prepend JENV_ROOT to PATH so `java` resolves to java.bat first.
REM    Read with DoNotExpandEnvironmentNames and write REG_EXPAND_SZ so existing
REM    %VAR% references survive. Machine PATH first when admin (it is searched
REM    before user PATH, so a user-only entry would still lose to a real JDK
REM    sitting on Machine PATH); otherwise user PATH + warning.
set "PATH_TARGETS=User"
if "%ADMIN%"=="1" set "PATH_TARGETS=Machine;User"
powershell -NoProfile -Command "$p='!JENV_ROOT!'; $opts=[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames; function JenvFixPath($reg,$key){ $k=$reg.OpenSubKey($key,$true); if($k){ $raw=$k.GetValue('PATH',$null,$opts); if($raw){ $parts=$raw -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ne $p.TrimEnd('\') }; $k.SetValue('PATH',($p+';'+($parts -join ';')),[Microsoft.Win32.RegistryValueKind]::ExpandString) } else { $k.SetValue('PATH',$p,[Microsoft.Win32.RegistryValueKind]::ExpandString) }; $k.Close() } }; $scopes='!PATH_TARGETS!'.Split(';'); foreach($s in $scopes){ if($s -eq 'Machine'){ JenvFixPath ([Microsoft.Win32.Registry]::LocalMachine) 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' } else { JenvFixPath ([Microsoft.Win32.Registry]::CurrentUser) 'Environment' } }"
echo [ok] JEnv dir prepended to PATH (!PATH_TARGETS! scope^(s^)).
if "%ADMIN%"=="0" echo [..] Machine PATH was not changed. Run this once as Administrator so `java` wins over a real JDK on Machine PATH.
echo.

REM 5. Current shell too.
endlocal & set "JAVA_HOME=%JENV_ROOT%" & set "PATH=%JENV_ROOT%;%PATH%" & echo JEnv installed. JAVA_HOME and PATH are active in this shell too.
goto :eof

:help
echo "jenv install"
echo One-time setup. Points JAVA_HOME at the JEnv directory (at both the user and,
echo when elevated, the system scope) and puts the JEnv directory first on PATH so
echo "java" runs through JEnv's shim. It is safe to run more than once.
echo Run it from an Administrator prompt to configure the whole machine.
goto :eof
