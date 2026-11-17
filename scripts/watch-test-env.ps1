$ErrorActionPreference = "Stop"

$startupScript = Join-Path (Split-Path -Parent $PSScriptRoot) "start-test-env.ps1"
$logPath = Join-Path (Split-Path -Parent $PSScriptRoot) ".firebase\test-env-autostart.log"
$requiredPorts = @(5000, 8081, 9099, 5002)

New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
"[$(Get-Date -Format s)] Test environment watchdog started." | Add-Content -Path $logPath

while ($true) {
  $listeningPorts = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in $requiredPorts } |
      Select-Object -ExpandProperty LocalPort -Unique
  )

  if (@($requiredPorts | Where-Object { $_ -notin $listeningPorts }).Count -gt 0) {
    try {
      "[$(Get-Date -Format s)] Starting or recovering the local test environment." | Add-Content -Path $logPath
      & $startupScript *>> $logPath
    } catch {
      "[$(Get-Date -Format s)] Startup failed: $_" | Add-Content -Path $logPath
    }
  }

  Start-Sleep -Seconds 10
}
