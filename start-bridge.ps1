$ErrorActionPreference = "Stop"
$bridgeDir = Join-Path $PSScriptRoot "agent-bridge"
Push-Location $bridgeDir
try {
  npm start
} finally {
  Pop-Location
}
