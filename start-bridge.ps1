$ErrorActionPreference = "Stop"
$envPath = Join-Path $PSScriptRoot ".env"
if (Test-Path $envPath) {
  Get-Content $envPath -Encoding utf8 | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), "Process")
    }
  }
}
$bridgeDir = Join-Path $PSScriptRoot "agent-bridge"
Push-Location $bridgeDir
try {
  npm start
} finally {
  Pop-Location
}
