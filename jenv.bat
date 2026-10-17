@echo off
REM jenv.bat - entry point: argument parsing, --version/--help, dispatch
REM Note: deliberately NOT using setlocal at top level, so that 'jenv use' can
REM propagate JENVUSE/JAVA_HOME back into the caller's cmd session. Sub-command
REM bats manage their own setlocal/endlocal as needed.

if "%JENV_APPDATA%"=="" set "JENV_APPDATA=%APPDATA%\JEnv"
if "%JENV_ROOT%"=="" set "JENV_ROOT=%~dp0"
if not "%JENV_ROOT:~-1%"=="" if "%JENV_ROOT:~-1%"=="\" set "JENV_ROOT=%JENV_ROOT:~0,-1%"
if "%JENV_VERSION%"=="" set "JENV_VERSION=v2.2.1"

if not exist "%JENV_APPDATA%" mkdir "%JENV_APPDATA%" 2>nul

set "ACTION=%~1"

REM --version / -v : zero side effects, before any config/env logic
if /i "%ACTION%"=="--version" goto :version
if /i "%ACTION%"=="-v" goto :version

REM --help / -h
if /i "%ACTION%"=="--help" goto :help
if /i "%ACTION%"=="-h" goto :help
if /i "%ACTION%"=="-help" goto :help
if /i "%ACTION%"=="/?" goto :help

REM Dispatch
if /i "%ACTION%"=="list"      goto :dispatch
if /i "%ACTION%"=="add"       goto :dispatch
if /i "%ACTION%"=="remove"    goto :dispatch
if /i "%ACTION%"=="change"    goto :dispatch
if /i "%ACTION%"=="use"       goto :dispatch
if /i "%ACTION%"=="local"     goto :dispatch
if /i "%ACTION%"=="getjava"   goto :dispatch
if /i "%ACTION%"=="link"      goto :dispatch
if /i "%ACTION%"=="uninstall" goto :dispatch
if /i "%ACTION%"=="install"  goto :dispatch
if /i "%ACTION%"=="autoscan"  goto :dispatch

if "%ACTION%"=="" goto :help
echo Unknown command "%ACTION%". Try "jenv --help".
goto :eof

:dispatch
call "%JENV_ROOT%\jenv-%ACTION%.bat" %2 %3 %4 %5 %6 %7 %8 %9
goto :eof

:version
echo %JENV_VERSION%
goto :eof

:help
echo "jenv list"                            List all registered Java-Envs.
echo "jenv add <name> <path>"               Adds a new Java-Version to JEnv which can be refferenced by the given name
echo "jenv remove <name>"                   Removes the specified Java-Version from JEnv
echo "jenv change <name>"                   Applys the given Java-Version globaly for all restarted shells and this one
echo "jenv use <name>"                      Applys the given Java-Version locally for the current shell
echo "jenv local <name>"                    Will use the given Java-Version whenever in this folder. Will set the Java-version for all subfolders as well
echo "jenv link <executable>"               Creates shortcuts for executables inside JAVA_HOME. For example "javac"
echo "jenv uninstall <name>"                Deletes JEnv and restores the specified java version to the system. You may keep your config file
echo "jenv install"                         One-time setup: points JAVA_HOME at the JEnv directory and puts it first on PATH. Run as Administrator for the whole machine
echo "jenv autoscan [--yes|-y] ?<path>?"    Will scan the given path for java installations and ask to add them to JEnv. Path is optional and "--yes|-y" accepts defaults.
echo Get help for individual commands using "jenv <list/add/remove/change/use/local> --help"
goto :eof
