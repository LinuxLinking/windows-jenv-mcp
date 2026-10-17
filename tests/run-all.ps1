# tests/run-all.ps1 - run the whole test suite. Exits non-zero if anything fails.
# Usage:  powershell -File tests\run-all.ps1
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$failed = 0
foreach ($s in @('run-cli.ps1', 'run-mcp.ps1')) {
    Write-Host ""
    Write-Host "########## $s ##########"
    & powershell -NoProfile -File (Join-Path $here $s)
    if ($LASTEXITCODE -ne 0) { $failed++ }
}
Write-Host ""
if ($failed -gt 0) { Write-Host "SUITE FAILED ($failed script(s) reported failures)"; exit 1 }
else { Write-Host "SUITE PASSED"; exit 0 }
