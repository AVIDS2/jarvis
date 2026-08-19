param(
  [ValidateSet("web", "legacy")]
  [string]$Ui = "legacy"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Get-Content (Join-Path $root ".env") -Encoding utf8 | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), "Process")
  }
}

$env:MINIMIND_JARVIS_BRIDGE_URL = "http://127.0.0.1:$($env:JARVIS_PORT)"
$env:MINIMIND_JARVIS_BRIDGE_MODEL = $env:JARVIS_MODEL
$env:MINIMIND_BACKEND_HTTP_BASE = "http://127.0.0.1:8111"
$env:MINIMIND_BACKEND_WS_URL = "ws://127.0.0.1:8111/ws/realtime"
$env:MINIMIND_ASR_MODE = "cloud"
$env:MINIMIND_TTS_MODE = "cloud"
$env:PYTHON = Join-Path $root ".venv\Scripts\python.exe"
$webRoot = Join-Path $root "..\pi-web"
$webUrl = "http://127.0.0.1:30141/"

if (-not (Test-Path $env:PYTHON)) {
  throw "Cloud Python environment is missing. Run: python -m venv jarvis/.venv; jarvis/.venv/Scripts/python -m pip install -r jarvis/requirements-cloud.txt"
}

$bridgePort = [int]$env:JARVIS_PORT
$bridgeReady = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $bridgePort -State Listen -ErrorAction SilentlyContinue
if (-not $bridgeReady) {
  Start-Process node -ArgumentList "bridge.mjs" -WorkingDirectory (Join-Path $root "agent-bridge") -WindowStyle Hidden
  Start-Sleep -Milliseconds 500
}

$webServer = $null
function Stop-StartedWebServer {
  if ($webServer -and -not $webServer.HasExited) {
    & taskkill.exe /PID $webServer.Id /T /F | Out-Null
  }
}
if ($Ui -eq "web") {
  if (-not (Test-Path $webRoot)) {
    throw "pi-web is missing: $webRoot"
  }
  try {
    $webReady = Invoke-WebRequest -UseBasicParsing -Uri $webUrl -TimeoutSec 2 -ErrorAction SilentlyContinue
  } catch {
    $webReady = $null
  }
  if (-not $webReady) {
    $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
    $webServer = Start-Process -FilePath $npmCommand -ArgumentList @("run", "dev") -WorkingDirectory $webRoot -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(45)
    do {
      Start-Sleep -Milliseconds 500
      try {
        $webReady = Invoke-WebRequest -UseBasicParsing -Uri $webUrl -TimeoutSec 2 -ErrorAction Stop
      } catch {
        $webReady = $null
      }
    } while (-not $webReady -and (Get-Date) -lt $deadline)
    if (-not $webReady) {
      Stop-StartedWebServer
      throw "pi-web did not become ready at $webUrl"
    }
  }
  $env:JARVIS_WEB_URL = $webUrl
} else {
  Remove-Item Env:JARVIS_WEB_URL -ErrorAction SilentlyContinue
}

Push-Location (Join-Path $root "..\whispera\electron-app")
try {
  npm start
} finally {
  Pop-Location
  Stop-StartedWebServer
}
