param(
  [switch]$Disable
)

$ErrorActionPreference = "Stop"
$taskName = "Planet Drugstore Local Test Environment"
$userId = "$env:USERDOMAIN\$env:USERNAME"

if ($Disable) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Automatic test environment startup has been disabled."
  } else {
    Write-Host "Automatic test environment startup was not installed."
  }
  return
}

$watchdogScript = Join-Path $PSScriptRoot "scripts\watch-test-env.ps1"
$powerShell = (Get-Process -Id $PID).Path
$action = New-ScheduledTaskAction `
  -Execute $powerShell `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogScript`"" `
  -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Keeps the local Firebase test environment running independently of VS Code." `
  -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Automatic test environment startup is enabled for Windows sign-in."
Write-Host "The watchdog runs independently of VS Code and retries if the emulators stop."
Write-Host "Log: $(Join-Path $PSScriptRoot '.firebase\test-env-autostart.log')"
