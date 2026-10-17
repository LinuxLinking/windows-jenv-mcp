@echo off
setlocal enabledelayedexpansion
set "JENV_ROOT=%~dp0"
if not "!JENV_ROOT:~-1!"=="" (
    if "!JENV_ROOT:~-1!"=="\" set "JENV_ROOT=!JENV_ROOT:~0,-1!"
)

set "EXE=%~1"

if /i "%EXE%"=="--help" goto :help
if /i "%EXE%"=="-h" goto :help

if "%EXE%"=="" (
    echo Missing executable. Usage: jenv link ^<executable^>
    goto :eof
)

REM Validate the executable name. It is interpolated unquoted into both the target path
REM (%JENV_ROOT%\%EXE%.bat, so "..\..\x" writes outside the JEnv directory) and into the
REM generated shim's command line, so a value like "foo&del" would create code rather than
REM a link. Allow plain executable characters only.
REM The `for /f delims=...` idiom: if the char is one of the delimiters, %%x is never
REM assigned and the body never runs.
set "BAD=0"
set "I=0"
:chkloop
if "!EXE:~%I%,1!"=="" goto :chkdone
set "C=!EXE:~%I%,1!"
set "OKC=0"
if "!C!"=="-" set "OKC=1"
if "!C!"=="_" set "OKC=1"
for /f "delims=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" %%c in ("!C!") do set "OKC=1"
set /a I+=1
if "!OKC!"=="0" set "BAD=1"
goto :chkloop
:chkdone
if "!BAD!"=="1" (
    echo Invalid executable name. Only letters, digits, "-" and "_" are allowed.
    goto :eof
)

REM Generate <exe>.bat in the JEnv root, same shape as java.bat (java -> exe).
REM Escape % as %% in the generated file (it runs in its own cmd context).
set "TARGET=%JENV_ROOT%\%EXE%.bat"
> "%TARGET%" (
    echo @echo off
    echo setlocal enabledelayedexpansion
    echo set "JENV_BAT=%%~dp0jenv.bat"
    echo set "var="
    echo for /f "usebackq delims=" %%%%i in ^(`call "%%JENV_BAT%%" getjava`^) do set "var=%%%%i"
    echo if exist "%%var%%\bin\%EXE%.exe" ^(
    echo     "%%var%%\bin\%EXE%.exe" %%*
    echo ^) else ^(
    echo     echo There was an error:
    echo     echo %%var%%
    echo ^)
)
echo Created link: %TARGET%
goto :eof

:help
echo "jenv link" ^<executable^>
echo With this command you can create shortcuts for executables inside JAVA_HOME
echo ^<executable^> is the name of the binary file for example "javac" or "javaw"
echo For example enable javac with: "jenv link javac"
echo List all registered java versions with "jenv list"
goto :eof
