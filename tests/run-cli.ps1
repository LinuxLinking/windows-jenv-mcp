# tests/run-cli.ps1 - CLI regression suite (portable, uses no real JDKs).
#
# Exercises add/list/getjava/change/use/local/remove against a throwaway
# registry (JENV_APPDATA) and fake JDK fixtures in a temp dir. The real machine
# (its %APPDATA%\JEnv, its JAVA_HOME, its PATH) is never touched.
#
# Assertions are on OUTPUT text, not exit codes: jenv's sub-commands report
# validation failures by printing a message and returning 0, so errorlevel is
# not a reliable signal. Exits 0 if every check passes, 1 otherwise.
#
# `use` and `local` propagate JENVUSE/JAVA_HOME to the CALLING process via
# `endlocal & set`, so a `getjava` that must observe them has to run in the
# SAME cmd session. Those checks are driven by a generated .bat helper.
#
# Usage:  powershell -File tests\run-cli.ps1        (or pwsh)

param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$jenv = Join-Path $root 'jenv.bat'

$sandbox = Join-Path $env:TEMP ("jenv-cli-" + [IO.Path]::GetRandomFileName())
$reg     = Join-Path $sandbox 'registry'
$fake21  = Join-Path $sandbox 'jdk21'
$fake17  = Join-Path $sandbox 'jdk17'
New-Item -ItemType Directory -Force -Path $reg, "$fake21\bin", "$fake17\bin" | Out-Null
New-Item -ItemType File -Force -Path "$fake21\bin\java.exe" | Out-Null
New-Item -ItemType File -Force -Path "$fake17\bin\java.exe" | Out-Null
Set-Content "$fake21\release" 'JAVA_VERSION="21.0.8"' -NoNewline
Set-Content "$fake17\release" 'JAVA_VERSION="17.0.6"' -NoNewline

$env:JENV_APPDATA = $reg
$script:pass = 0; $script:fail = 0

function Invoke-Jenv {
    # $a is the full argument string; quote any path that contains spaces with
    # doubled quotes (\") so cmd sees one argument.
    param([string]$a)
    return (& cmd.exe /c "`"$jenv`" $a" 2>&1 | Out-String)
}
function Assert-Contains {
    param([string]$label, [string]$needle, [string]$out)
    if ($out -like "*$needle*") { $script:pass++; if(-not $Quiet){ Write-Host "[PASS] $label" } }
    else { $script:fail++; Write-Host "[FAIL] $label -- missing: $needle"; Write-Host "       got: $($out.Trim())" }
}

Write-Host "=== CLI suite (isolated registry) ==="

$o = Invoke-Jenv "add jdk21 `"$fake21`"";                 Assert-Contains "add jdk21" "Successfully added" $o
$o = Invoke-Jenv "add jdk17 `"$fake17`"";                 Assert-Contains "add jdk17" "Successfully added" $o
$o = Invoke-Jenv "add jdk21 `"$fake21`"";                 Assert-Contains "add duplicate name rejected" "already a JEnv with the name" $o
$o = Invoke-Jenv "add `"bad name`" `"$fake17`"";          Assert-Contains "add invalid name rejected" "Invalid name" $o
$o = Invoke-Jenv "add nope `"$sandbox\does-not-exist`""; Assert-Contains "add bad path rejected" "not a valid JAVA_HOME" $o

$o = Invoke-Jenv "list";                                  Assert-Contains "list shows jdk21" "jdk21" $o
                                                         Assert-Contains "list shows jdk17" "jdk17" $o

$o = Invoke-Jenv "getjava";                               Assert-Contains "getjava with no global" "No global java version found" $o

$o = Invoke-Jenv "change jdk21";                          Assert-Contains "change jdk21" "JEnv changed globally" $o
$o = Invoke-Jenv "getjava";                               Assert-Contains "getjava resolves global jdk21" $fake21 $o

# `use` state lives in the process that ran it; run use + getjava in one session.
$useBat = Join-Path $sandbox 'usecheck.bat'
@"
@echo off
call "$jenv" use jdk17
call "$jenv" getjava
"@ | Set-Content $useBat
$o = (& cmd.exe /c "`"$useBat`"" 2>&1 | Out-String)
Assert-Contains "use overrides global" $fake17 $o

# same for use remove -> back to global
$useBat2 = Join-Path $sandbox 'usecheck2.bat'
@"
@echo off
call "$jenv" use remove
call "$jenv" getjava
"@ | Set-Content $useBat2
$o = (& cmd.exe /c "`"$useBat2`"" 2>&1 | Out-String)
Assert-Contains "use remove falls back to global" $fake21 $o

# local binding applies to the exact directory (no inheritance)
$locBat = Join-Path $sandbox 'localcheck.bat'
@"
@echo off
cd /d "$sandbox"
call "$jenv" local jdk17
call "$jenv" getjava
call "$jenv" local remove
"@ | Set-Content $locBat
$o = (& cmd.exe /c "`"$locBat`"" 2>&1 | Out-String)
Assert-Contains "local binding applies in its dir" $fake17 $o

$o = Invoke-Jenv "remove jdk21";                          Assert-Contains "remove jdk21" "removed successfully" $o
$o = Invoke-Jenv "remove jdk21";                          Assert-Contains "remove missing name rejected" "no JEnv with name" $o

Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Passed: $script:pass   Failed: $script:fail"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
