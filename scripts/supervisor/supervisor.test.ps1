[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$supervisor = Join-Path $root "scripts\jarvis-supervisor.ps1"
$temp = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-supervisor-test-" + [guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($temp) | Out-Null
$log = Join-Path $temp "supervisor.jsonl"
$state = Join-Path $temp "state.json"
$lock = Join-Path $temp "lock.json"

try {
  $statusJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -Mode status -Json
  if ($LASTEXITCODE -notin @(0, 2)) { throw "status exited with $LASTEXITCODE" }
  $status = ($statusJson -join "`n") | ConvertFrom-Json
  if ($status.health.bridge.port -ne 3030 -or $status.health.voice.port -ne 8111) {
    throw "supervisor did not inspect the project ports"
  }

  $onceJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -Mode once -DryRun -Json -LogPath $log -StatePath $state -LockPath $lock
  if ($LASTEXITCODE -notin @(0, 2)) { throw "dry-run once exited with $LASTEXITCODE" }
  $once = ($onceJson -join "`n") | ConvertFrom-Json
  if ($once.action -eq "launch_requested") { throw "dry-run attempted to launch" }
  if (-not (Test-Path -LiteralPath $log)) { throw "supervisor did not write JSONL log" }
  $lines = @(Get-Content -LiteralPath $log | ForEach-Object { $_ | ConvertFrom-Json })
  if ($lines.Count -lt 1) { throw "supervisor JSONL log is empty" }
  if (Test-Path -LiteralPath $lock) { throw "lock file was not released" }

  Write-Output ("supervisor smoke passed: status={0}, action={1}, log_events={2}" -f $status.ok, $once.action, $lines.Count)
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
