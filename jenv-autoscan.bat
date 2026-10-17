@echo off
setlocal enabledelayedexpansion
if not defined JENV_APPDATA set "JENV_APPDATA=%APPDATA%\JEnv"
set "JENV_ROOT=%~dp0"
if not "!JENV_ROOT:~-1!"=="" (
    if "!JENV_ROOT:~-1!"=="\" set "JENV_ROOT=!JENV_ROOT:~0,-1!"
)

set "ACCEPT=0"
set "SCANPATH="
REM Parse args: -y/--yes sets ACCEPT, remaining is path
:argloop
if "%~1"=="" goto :argdone
set "A=%~1"
if /i "!A!"=="-y" ( set "ACCEPT=1" & shift & goto :argloop )
if /i "!A!"=="--yes" ( set "ACCEPT=1" & shift & goto :argloop )
if /i "!A!"=="--help" goto :help
if /i "!A!"=="-h" goto :help
if "!SCANPATH!"=="" ( set "SCANPATH=%~1" & shift & goto :argloop )
shift
goto :argloop
:argdone

echo JEnv is now searching for java.exe on your Computer. This could take some time...

if "!SCANPATH!"=="" (
    REM Enumerate drives by probing drive letters rather than parsing fsutil output.
    REM That output is locale-dependent, and a delims-colon token split only happens to
    REM work on one language: the Chinese build prints a single line listing every drive,
    REM while the English build prints one line per drive with the medium type appended -
    REM which makes the last token the tail of that line, and the scan then silently finds
    REM nothing at all.
    set "FOUNDANY="
    for %%D in (C D E F G H I J K L M N O P Q R S T U V W X Y Z) do (
        if exist "%%D:\" (
            set "FOUNDANY=1"
            call :scanroot "%%D:\"
        )
    )
    if not defined FOUNDANY (
        echo Could not enumerate drives.
        goto :eof
    )
) else (
    REM No trailing backslash inside the quoted path of an existence test: it escapes the
    REM closing quote and cmd then reports that the path cannot be found.
    if not exist "!SCANPATH!" (
        echo The provided path does not exist
        goto :eof
    )
    call :scanroot "!SCANPATH!"
)
goto :eof

REM Scans one root, recursively, for JDKs. This is a subroutine rather than an inline
REM `for %%R in (!ROOTS!)` because a FOR ... IN set is tokenised on spaces, which silently
REM turned `jenv autoscan "C:\Program Files\Java"` into the two bogus roots `C:\Program` and
REM `Files\Java` - the single most common invocation found nothing at all. `call :scanroot`
REM passes the path as one quoted argument, so spaces and parentheses survive.
:scanroot
set "R=%~1"
REM %%R may be like C:\ ; strip the trailing backslash for join safety
if not "!R!"=="" (
    if "!R:~-1!"=="\" set "R=!R:~0,-1!"
    for /f "usebackq delims=" %%F in (`dir /s /b "!R!\java.exe" 2^>nul`) do (
        REM Accept only a java.exe sitting directly in a bin folder. This used to be a
        REM findstr regular expression, which was unreliable: it rejected a plain
        REM jdk/jre/bin/java.exe layout while accepting a deeply nested one, so the scan
        REM silently found nothing on many machines. Comparing the file name and its
        REM parent folder in plain batch is exact and predictable.
        set "FOUND=%%F"
        set "ISJDK=0"
        for %%A in ("!FOUND!") do (
            if /i "%%~nxA"=="java.exe" (
                for %%B in ("%%~dpA.") do if /i "%%~nxB"=="bin" set "ISJDK=1"
            )
        )
        if "!ISJDK!"=="1" (
            REM Skip anything inside the JEnv root itself (e.g. test fakes). An empty
            REM JENV_ROOT would make the findstr below match everything, so guard it.
            set "SKIP=0"
            if defined JENV_ROOT (
                echo !FOUND! | findstr /i /c:"!JENV_ROOT!" >nul
                if not errorlevel 1 set "SKIP=1"
            )
            if "!SKIP!"=="0" (
                call :consider "!FOUND!"
            )
        )
    )
)
goto :eof

:consider
set "JAVA=%~1"
REM Derive JAVA_HOME: strip \bin\java.exe
set "JHOME=!JAVA!"
set "JHOME=!JHOME:\bin\java.exe=!"
REM Default name = major version
set "MAJOR="
for /f "usebackq delims=" %%m in (`call "%JENV_ROOT%\jenv-config.bat" :major_version "!JAVA!"`) do set "MAJOR=%%m"
if "!MAJOR!"=="" set "MAJOR=java"

if "!ACCEPT!"=="1" (
    call "%JENV_ROOT%\jenv-add.bat" "!MAJOR!" "!JHOME!"
    goto :eof
)

echo Found java.exe at !JAVA!. Default name is: '!MAJOR!'.
set /p ANS="Do you want to add it to the list? [Y]es/[N]o/[R]ename: "
set "A=%ANS%"
set "A=!A:~0,1!"
if /i "!A!"=="y" (
    call "%JENV_ROOT%\jenv-add.bat" "!MAJOR!" "!JHOME!"
    goto :eof
)
if /i "!A!"=="r" (
    set /p NEWNAME="Enter the new name for !JAVA! "
    if not "!NEWNAME!"=="" call "%JENV_ROOT%\jenv-add.bat" "!NEWNAME!" "!JHOME!"
    goto :eof
)
goto :eof

:help
echo "jenv autoscan ^<path^>"
echo This will search for any java.exe files in the given path and prompt the user to add them to JEnv
echo ^<path^> is the path to search like "C:\Program Files\Java"
echo If ^<path^> is not provided, JEnv will search the entire system
goto :eof
