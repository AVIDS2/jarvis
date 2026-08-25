[CmdletBinding()]
param(
  [ValidateSet("status", "once", "watch")]
  [string]$Mode = "status",
  [switch]$DryRun,
  [switch]$Json,
  [ValidateRange(1, 3600)]
  [int]$IntervalSec = 5,
  [ValidateRange(1, 300)]
  [int]$ReadinessTimeoutSec = 20,
  [ValidateRange(1, 300)]
  [int]$BaseBackoffSec = 2,
  [ValidateRange(1, 3600)]
  [int]$MaxBackoffSec = 60,
  [string]$LogPath = "",
  [string]$StatePath = "",
  [string]$LockPath = ""
)

$ErrorActionPreference = "Stop"
$script:Root = Split-Path -Parent $PSScriptRoot
$script:BridgePort = 3030
$script:VoicePort = 8111
$script:LaunchScript = Join-Path $script:Root "launch-legacy-hidden.vbs"
$script:DiagnosticsDir = Join-Path $script:Root "runtime\diagnostics"
$script:LogPath = if ($LogPath) { $LogPath } else { Join-Path $script:DiagnosticsDir "supervisor.jsonl" }
$script:StatePath = if ($StatePath) { $StatePath } else { Join-Path $script:DiagnosticsDir "supervisor-state.json" }
$script:LockPath = if ($LockPath) { $LockPath } else { Join-Path $script:DiagnosticsDir "supervisor.lock.json" }
$script:Mutex = $null
$script:MutexHeld = $false

function Get-UtcIso {
  return [DateTimeOffset]::UtcNow.ToString("o")
}

function Ensure-ParentDirectory([string]$Path) {
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    [IO.Directory]::CreateDirectory($parent) | Out-Null
  }
}

function Write-JsonLog([string]$Event, [hashtable]$Fields = @{}) {
  try {
    Ensure-ParentDirectory $script:LogPath
    $record = [ordered]@{
      timestamp = Get-UtcIso
      event = $Event
      mode = $Mode
      pid = $PID
    }
    foreach ($key in $Fields.Keys) {
      $record[$key] = $Fields[$key]
    }
    Add-Content -LiteralPath $script:LogPath -Value ($record | ConvertTo-Json -Compress -Depth 8) -Encoding utf8
  } catch {
    [Console]::Error.WriteLine("Jarvis supervisor log error: $($_.Exception.Message)")
  }
}

function Get-PortOwner([int]$Port) {
  $connection = $null
  try {
    $connection = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalAddress -eq "127.0.0.1" -or $_.LocalAddress -eq "0.0.0.0" } |
      Select-Object -First 1)
  } catch {
    $connection = @()
  }
  if (-not $connection) {
    return [pscustomobject]@{ listening = $false; pid = $null; process = $null; local_address = $null }
  }
  $ownerPid = [int]$connection[0].OwningProcess
  $processName = $null
  try {
    $processName = (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName
  } catch {
    $processName = $null
  }
  return [pscustomobject]@{
    listening = $true
    pid = $ownerPid
    process = $processName
    local_address = $connection[0].LocalAddress
  }
}

function Invoke-Health([string]$Name, [int]$Port) {
  $url = "http://127.0.0.1:$Port/health"
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $statusCode = $null
  $payload = $null
  $errorMessage = $null
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3 -ErrorAction Stop
    $statusCode = [int]$response.StatusCode
    try { $payload = $response.Content | ConvertFrom-Json } catch { $payload = $null }
  } catch {
    $errorMessage = $_.Exception.Message
  }
  $timer.Stop()
  $semanticHealthy = $false
  if ($payload) {
    $semanticHealthy = $true
    if ($Name -eq "bridge" -and $payload.PSObject.Properties.Name -contains "ok") {
      $semanticHealthy = [bool]$payload.ok
    }
    if ($Name -eq "voice" -and $payload.PSObject.Properties.Name -contains "status") {
      $semanticHealthy = ([string]$payload.status -eq "ok")
    }
  }
  $listener = Get-PortOwner $Port
  $details = [ordered]@{}
  if ($payload) {
    foreach ($field in @("ok", "status", "service", "provider", "model", "upstream_ok", "asr_warmed", "tts_warmed", "sleeping", "wake_word_phrase")) {
      if ($payload.PSObject.Properties.Name -contains $field) { $details[$field] = $payload.$field }
    }
  }
  return [pscustomobject]@{
    name = $Name
    port = $Port
    url = $url
    healthy = ($statusCode -eq 200 -and $semanticHealthy)
    status_code = $statusCode
    latency_ms = [math]::Round($timer.Elapsed.TotalMilliseconds, 2)
    error = $errorMessage
    listener = $listener
    details = [pscustomobject]$details
  }
}

function Get-HealthSnapshot {
  $bridge = Invoke-Health "bridge" $script:BridgePort
  $voice = Invoke-Health "voice" $script:VoicePort
  return [pscustomobject]@{
    checked_at = Get-UtcIso
    healthy = ($bridge.healthy -and $voice.healthy)
    bridge = $bridge
    voice = $voice
  }
}

function Read-State {
  $default = [pscustomobject]@{
    failure_count = 0
    next_attempt_utc = $null
    last_launch_utc = $null
    last_result = $null
  }
  if (-not (Test-Path -LiteralPath $script:StatePath)) { return $default }
  try {
    $state = Get-Content -LiteralPath $script:StatePath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($null -eq $state.failure_count) { $state | Add-Member -NotePropertyName failure_count -NotePropertyValue 0 }
    return $state
  } catch {
    Write-JsonLog "state_read_error" @{ error = $_.Exception.Message }
    return $default
  }
}

function Write-State($State) {
  Ensure-ParentDirectory $script:StatePath
  $temp = "$($script:StatePath).tmp.$PID"
  Set-Content -LiteralPath $temp -Value ($State | ConvertTo-Json -Depth 8) -Encoding utf8
  Move-Item -LiteralPath $temp -Destination $script:StatePath -Force
}

function Reset-State {
  if ($DryRun) { return }
  Write-State ([pscustomobject]@{
    failure_count = 0
    next_attempt_utc = $null
    last_launch_utc = $null
    last_result = "healthy"
  })
}

function Register-Failure([string]$Reason) {
  $state = Read-State
  $failureCount = [int]$state.failure_count + 1
  $shift = [math]::Min($failureCount - 1, 10)
  $delay = [int][math]::Min($MaxBackoffSec, $BaseBackoffSec * [math]::Pow(2, $shift))
  $next = [DateTimeOffset]::UtcNow.AddSeconds($delay).ToString("o")
  $nextState = [pscustomobject]@{
    failure_count = $failureCount
    next_attempt_utc = $next
    last_launch_utc = $state.last_launch_utc
    last_result = $Reason
  }
  if (-not $DryRun) { Write-State $nextState }
  return [pscustomobject]@{ failure_count = $failureCount; delay_sec = $delay; next_attempt_utc = $next }
}

function Get-Backoff([object]$State) {
  if (-not $State.next_attempt_utc) { return $null }
  try {
    $next = [DateTimeOffset]::Parse([string]$State.next_attempt_utc)
    $remaining = [math]::Ceiling(($next - [DateTimeOffset]::UtcNow).TotalSeconds)
    if ($remaining -gt 0) { return [pscustomobject]@{ remaining_sec = [int]$remaining; next_attempt_utc = $next.ToString("o") } }
  } catch {
    Write-JsonLog "state_date_error" @{ error = $_.Exception.Message }
  }
  return $null
}

function Get-LockInfo {
  if (-not (Test-Path -LiteralPath $script:LockPath)) { return $null }
  try { return Get-Content -LiteralPath $script:LockPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { return $null }
}

function Test-LiveLockFile {
  $info = Get-LockInfo
  if (-not $info -or -not $info.pid) { return $false }
  try {
    $process = Get-Process -Id ([int]$info.pid) -ErrorAction Stop
    if ($info.process_start_utc) {
      $started = $process.StartTime.ToUniversalTime()
      $recorded = [DateTimeOffset]::Parse([string]$info.process_start_utc).UtcDateTime
      if ([math]::Abs(($started - $recorded).TotalSeconds) -lt 3) { return $true }
      return $false
    }
    return $true
  } catch {
    return $false
  }
}

function Acquire-Lock {
  $script:Mutex = New-Object Threading.Mutex($false, "Local\JarvisSupervisor-3030-8111")
  try {
    if (-not $script:Mutex.WaitOne(0)) {
      Write-JsonLog "lock_busy" @{ lock_path = $script:LockPath }
      throw "Jarvis supervisor is already running for ports 3030/8111."
    }
  } catch [Threading.AbandonedMutexException] {
    $script:MutexHeld = $true
  }
  $script:MutexHeld = $true
  if (Test-LiveLockFile) {
    $info = Get-LockInfo
    throw "Jarvis supervisor lock is held by PID $($info.pid)."
  }
  Ensure-ParentDirectory $script:LockPath
  $current = Get-Process -Id $PID
  $lock = [ordered]@{
    pid = $PID
    process_start_utc = $current.StartTime.ToUniversalTime().ToString("o")
    acquired_at_utc = Get-UtcIso
    root = $script:Root
    ports = @($script:BridgePort, $script:VoicePort)
    launch_command = "wscript.exe //B launch-legacy-hidden.vbs"
    mode = $Mode
  }
  Set-Content -LiteralPath $script:LockPath -Value ($lock | ConvertTo-Json -Compress) -Encoding utf8
}

function Release-Lock {
  if ($script:MutexHeld) {
    $info = Get-LockInfo
    if ($info -and [int]$info.pid -eq $PID) {
      Remove-Item -LiteralPath $script:LockPath -Force -ErrorAction SilentlyContinue
    }
    try { $script:Mutex.ReleaseMutex() } catch { }
    $script:Mutex.Dispose()
    $script:MutexHeld = $false
  }
}

function Start-Jarvis {
  if (-not (Test-Path -LiteralPath $script:LaunchScript)) {
    throw "Launch script is missing: $($script:LaunchScript)"
  }
  $quotedLaunchScript = '"' + $script:LaunchScript + '"'
  $command = "wscript.exe //B $quotedLaunchScript"
  if ($DryRun) {
    Write-JsonLog "launch_skipped" @{ reason = "dry_run"; command = $command }
    return [pscustomobject]@{ requested = $false; dry_run = $true; command = $command; pid = $null }
  }
  $process = Start-Process -FilePath "wscript.exe" -ArgumentList @("//B", $quotedLaunchScript) -WorkingDirectory $script:Root -WindowStyle Hidden -PassThru
  $state = Read-State
  if (-not $DryRun) {
    Write-State ([pscustomobject]@{
      failure_count = $state.failure_count
      next_attempt_utc = $state.next_attempt_utc
      last_launch_utc = Get-UtcIso
      last_result = "launch_requested"
    })
  }
  Write-JsonLog "launch_requested" @{ command = $command; launcher_pid = $process.Id }
  return [pscustomobject]@{ requested = $true; dry_run = $false; command = $command; pid = $process.Id }
}

function Wait-ForHealthy([int]$TimeoutSec) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSec)
  $snapshot = Get-HealthSnapshot
  while (-not $snapshot.healthy -and [DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $snapshot = Get-HealthSnapshot
  }
  return $snapshot
}

function Invoke-Once {
  $before = Get-HealthSnapshot
  if ($before.healthy) {
    Reset-State
    Write-JsonLog "healthy" @{ bridge_latency_ms = $before.bridge.latency_ms; voice_latency_ms = $before.voice.latency_ms }
    return [pscustomobject]@{ ok = $true; action = "none"; health = $before; backoff = $null }
  }
  $state = Read-State
  $backoff = Get-Backoff $state
  if ($backoff) {
    Write-JsonLog "backoff" @{ remaining_sec = $backoff.remaining_sec; next_attempt_utc = $backoff.next_attempt_utc }
    return [pscustomobject]@{ ok = $false; action = "backoff"; health = $before; backoff = $backoff }
  }
  $launch = Start-Jarvis
  if ($DryRun) {
    return [pscustomobject]@{ ok = $false; action = "launch_skipped"; health = $before; launch = $launch; backoff = $null }
  }
  $after = Wait-ForHealthy $ReadinessTimeoutSec
  if ($after.healthy) {
    Reset-State
    Write-JsonLog "recovered" @{ readiness_timeout_sec = $ReadinessTimeoutSec }
    return [pscustomobject]@{ ok = $true; action = "recovered"; health = $after; launch = $launch; backoff = $null }
  }
  $failure = Register-Failure "healthcheck_failed_after_launch"
  Write-JsonLog "healthcheck_failed" @{ failure_count = $failure.failure_count; next_attempt_utc = $failure.next_attempt_utc }
  return [pscustomobject]@{ ok = $false; action = "launch_failed"; health = $after; launch = $launch; backoff = $failure }
}

function Get-StatusResult {
  $health = Get-HealthSnapshot
  $state = Read-State
  return [pscustomobject]@{
    ok = $health.healthy
    mode = "status"
    checked_at = $health.checked_at
    root = $script:Root
    launch_script = [pscustomobject]@{ path = $script:LaunchScript; exists = (Test-Path -LiteralPath $script:LaunchScript) }
    health = $health
    state = $state
    lock = Get-LockInfo
  }
}

function Write-Result($Result) {
  if ($Json) {
    $Result | ConvertTo-Json -Depth 12
    return
  }
  $label = if ($Result.ok) { "healthy" } else { "degraded" }
  Write-Output "Jarvis supervisor: $label"
  if ($Result.health) {
    Write-Output ("  bridge 3030: {0} ({1} ms)" -f $(if ($Result.health.bridge.healthy) { "ok" } else { "down" }), $Result.health.bridge.latency_ms)
    Write-Output ("  voice  8111: {0} ({1} ms)" -f $(if ($Result.health.voice.healthy) { "ok" } else { "down" }), $Result.health.voice.latency_ms)
  }
  if ($Result.action) { Write-Output "  action: $($Result.action)" }
}

try {
  Ensure-ParentDirectory $script:LogPath
  if ($Mode -eq "status") {
    $status = Get-StatusResult
    Write-Result $status
    if (-not $status.ok) { exit 2 }
    exit 0
  }
  Acquire-Lock
  if ($Mode -eq "once") {
    $result = Invoke-Once
    Write-Result $result
    if (-not $result.ok) { exit 2 }
    exit 0
  }
  while ($true) {
    $result = Invoke-Once
    Write-Result $result
    $sleepSec = $IntervalSec
    if ($result.backoff -and $result.backoff.remaining_sec) {
      $sleepSec = [int][math]::Min($IntervalSec, [math]::Max(1, [int]$result.backoff.remaining_sec))
    }
    Start-Sleep -Seconds $sleepSec
  }
} catch {
  Write-JsonLog "supervisor_error" @{ error = $_.Exception.Message }
  [Console]::Error.WriteLine("Jarvis supervisor error: $($_.Exception.Message)")
  exit 1
} finally {
  Release-Lock
}
