# tests/run-mcp.ps1 - MCP server regression suite (portable, no real JDKs needed).
#
# Drives mcp/server.js over stdio JSON-RPC against a throwaway registry
# (JENV_APPDATA) and fake JDK fixtures. The real machine is never touched.
#
# The fixtures give each fake JDK an empty bin\java.exe (the server only checks
# that it EXISTS) plus a `release` file so versions are reported. jenv_run's
# execution path is exercised with the system's own cmd.exe (command 'cmd'),
# echoing %JAVA_HOME% -- which proves the child received the injected
# JAVA_HOME without needing a real JDK.

param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$server = Join-Path $root 'mcp\server.js'

$sandbox = Join-Path $env:TEMP ("jenv-mcp-" + [IO.Path]::GetRandomFileName())
$reg     = Join-Path $sandbox 'registry'
$jdk21   = Join-Path $sandbox 'jdk21'
$jdk17   = Join-Path $sandbox 'jdk17'
New-Item -ItemType Directory -Force -Path $reg, "$jdk21\bin", "$jdk17\bin" | Out-Null
# empty bin\java.exe: satisfies the server's "exists" check without being run
New-Item -ItemType File -Force -Path "$jdk21\bin\java.exe" | Out-Null
New-Item -ItemType File -Force -Path "$jdk17\bin\java.exe" | Out-Null
# release files, ASCII, JAVA_VERSION on its own line (server regex ^JAVA_VERSION="..")
[IO.File]::WriteAllText("$jdk21\release", "IMPLEMENTOR=`"Test`"`r`nJAVA_VERSION=`"21.0.8`"`r`n")
[IO.File]::WriteAllText("$jdk17\release", "IMPLEMENTOR=`"Test`"`r`nJAVA_VERSION=`"17.0.6`"`r`n")
[IO.File]::WriteAllText((Join-Path $reg 'jenvs.txt'), "jdk21=$jdk21`r`njdk17=$jdk17`r`n")
[IO.File]::WriteAllText((Join-Path $reg 'global.txt'), "$jdk21`r`n")
[IO.File]::WriteAllText((Join-Path $reg 'locals.txt'), "`r`n")

$env:JENV_APPDATA = $reg
$script:pass = 0; $script:fail = 0

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[SKIP] node not on PATH; cannot run MCP suite"
    exit 0
}

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = "`"$server`""
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$proc = [Diagnostics.Process]::Start($psi)
$stdout = $proc.StandardOutput
$script:id = 0

function Send-Json($msg) {
    $proc.StandardInput.WriteLine(($msg | ConvertTo-Json -Depth 10 -Compress))
    $proc.StandardInput.Flush()
}
function Read-Reply($rid, $timeoutMs = 10000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
        $line = $stdout.ReadLine()
        if ($null -eq $line) { break }
        if ($line -notmatch '"id"') { continue }
        try { $o = $line | ConvertFrom-Json; if ($o.id -eq $rid) { return $o } } catch {}
    }
    return $null
}
function Call-Tool($name, $argObj) {
    $script:id++; $rid = $script:id
    Send-Json @{ jsonrpc='2.0'; id=$rid; method='tools/call'; params=@{ name=$name; arguments=$argObj } }
    $r = Read-Reply $rid
    if ($null -eq $r -or $null -eq $r.result) { return '' }
    return (($r.result.content | ForEach-Object { $_.text }) -join "`n")
}
function Assert-Contains {
    param([string]$label, [string]$needle, [string]$out)
    if ($out -like "*$needle*") { $script:pass++; if(-not $Quiet){ Write-Host "[PASS] $label" } }
    else { $script:fail++; Write-Host "[FAIL] $label -- missing: $needle"; Write-Host "       got: $($out.Trim())" }
}

Write-Host "=== MCP suite (isolated registry) ==="

$script:id++; $rid = $script:id
Send-Json @{ jsonrpc='2.0'; id=$rid; method='initialize'; params=@{ protocolVersion='2024-11-05'; capabilities=@{}; clientInfo=@{ name='test'; version='0' } } }
$init = Read-Reply $rid
if ($null -ne $init -and $null -ne $init.result) { $script:pass++; if(-not $Quiet){ Write-Host "[PASS] initialize" } }
else { $script:fail++; Write-Host "[FAIL] initialize" }
Send-Json @{ jsonrpc='2.0'; method='notifications/initialized' }

$o = Call-Tool 'jenv_list' @{}
Assert-Contains "list shows jdk21" "jdk21" $o
Assert-Contains "list reports version 21.0.8" "21.0.8" $o

$o = Call-Tool 'jenv_current' @{ cwd = $root }
Assert-Contains "current resolves global jdk21" "21.0.8" $o
Assert-Contains "current source is global" "source:" $o

$o = Call-Tool 'jenv_current' @{ use = 'jdk17' }
Assert-Contains "current with use=jdk17" "17.0.6" $o

# jenv_run: use an absolute fake JDK (has bin\java.exe), run the system's cmd to
# echo %JAVA_HOME% -- proves the child got the injected JAVA_HOME.
$o = Call-Tool 'jenv_run' @{ use = $jdk21; command = 'cmd'; args = @('/c', 'echo %JAVA_HOME%') }
Assert-Contains "jenv_run injects JAVA_HOME into child" $jdk21 $o

# Close stdin so the server exits, THEN read its stderr (reading stderr while
# the process is alive and holding stdin would block forever).
$proc.StandardInput.Close()
$proc.WaitForExit(5000) | Out-Null
$stderr = ''
try { $stderr = $proc.StandardError.ReadToEnd() } catch {}
if ($stderr -match 'failed') { $script:fail++; Write-Host "[FAIL] server logged 'failed': $stderr" }
else { $script:pass++; if(-not $Quiet){ Write-Host "[PASS] server log clean (no 'failed')" } }

Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Passed: $script:pass   Failed: $script:fail"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
