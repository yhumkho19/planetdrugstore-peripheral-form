$ErrorActionPreference = "Stop"

$javaHomeCandidates = @()
if ($env:JAVA_HOME) {
  $javaHomeCandidates += $env:JAVA_HOME
}
foreach ($programFilesRoot in @($env:ProgramW6432, $env:ProgramFiles) | Where-Object { $_ } | Select-Object -Unique) {
  $javaHomeCandidates += Join-Path $programFilesRoot "Android\Android Studio\jbr"
}
$compatibleJavaHome = $javaHomeCandidates | Where-Object {
  $javaExecutable = Join-Path $_ "bin\java.exe"
  if (-not (Test-Path $javaExecutable)) { return $false }
  $versionOutput = & $javaExecutable -version 2>&1 | Out-String
  $versionMatch = [regex]::Match($versionOutput, 'version "(?<major>\d+)')
  $versionMatch.Success -and [int]$versionMatch.Groups["major"].Value -ge 21
} | Select-Object -First 1
if (-not $compatibleJavaHome) {
  throw "Java 21 or newer was not found. Set JAVA_HOME or install Android Studio with its bundled JBR."
}

$env:JAVA_HOME = $compatibleJavaHome
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

$localAuthHealthUrl = "http://127.0.0.1:5002/health"
$localAuthHealthHeaders = @{ Origin = "http://127.0.0.1:5000" }
$localAuthServer = Join-Path $PSScriptRoot "scripts\local-employee-auth.cjs"
$localAuthIsRunning = $false
try {
  $localAuthResponse = Invoke-RestMethod -Uri $localAuthHealthUrl -Headers $localAuthHealthHeaders -TimeoutSec 2
  $localAuthIsRunning = $localAuthResponse.ok -eq $true -and $localAuthResponse.projectId -eq "demo-peripherals-local"
} catch {}

$requiredPorts = @(5000, 8081, 9099)
$trackedPorts = @(4000) + $requiredPorts
$listeningPorts = @(
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in $trackedPorts } |
    Select-Object -ExpandProperty LocalPort -Unique
)
if ($listeningPorts.Count -gt 0) {
  $corePortsAreListening = @($requiredPorts | Where-Object { $_ -notin $listeningPorts }).Count -eq 0
  $uiIsEmulator = $true
  $hostingIsProject = $false
  try {
    if (4000 -in $listeningPorts) {
      $uiResponse = Invoke-WebRequest -Uri "http://127.0.0.1:4000/" -UseBasicParsing -TimeoutSec 3
      $uiIsEmulator = $uiResponse.Content -match "Firebase Emulator Suite"
    }
    $hostingResponse = Invoke-WebRequest -Uri "http://127.0.0.1:5000/" -UseBasicParsing -TimeoutSec 3
    $hostingIsProject = $hostingResponse.StatusCode -eq 200
  } catch {}

  if ($corePortsAreListening -and $uiIsEmulator -and $hostingIsProject) {
    if (-not $localAuthIsRunning) {
      $localAuthPort = Get-NetTCPConnection -State Listen -LocalPort 5002 -ErrorAction SilentlyContinue
      if ($localAuthPort) {
        throw "Port 5002 is in use by a service that is not the local employee-auth test helper."
      }

      $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
      $localAuthLog = Join-Path $PSScriptRoot ".firebase\local-employee-auth.log"
      $localAuthErrorLog = Join-Path $PSScriptRoot ".firebase\local-employee-auth-error.log"
      $previousFirestoreEmulatorHost = $env:FIRESTORE_EMULATOR_HOST
      $previousAuthEmulatorHost = $env:FIREBASE_AUTH_EMULATOR_HOST
      try {
        $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8081"
        $env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
        $null = Start-Process -FilePath $nodeExecutable `
          -ArgumentList "`"$localAuthServer`"" `
          -WorkingDirectory $PSScriptRoot `
          -WindowStyle Hidden `
          -RedirectStandardOutput $localAuthLog `
          -RedirectStandardError $localAuthErrorLog
      } finally {
        if ($null -eq $previousFirestoreEmulatorHost) {
          Remove-Item Env:FIRESTORE_EMULATOR_HOST -ErrorAction SilentlyContinue
        } else {
          $env:FIRESTORE_EMULATOR_HOST = $previousFirestoreEmulatorHost
        }
        if ($null -eq $previousAuthEmulatorHost) {
          Remove-Item Env:FIREBASE_AUTH_EMULATOR_HOST -ErrorAction SilentlyContinue
        } else {
          $env:FIREBASE_AUTH_EMULATOR_HOST = $previousAuthEmulatorHost
        }
      }

      $authReady = $false
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
          $localAuthResponse = Invoke-RestMethod -Uri $localAuthHealthUrl -Headers $localAuthHealthHeaders -TimeoutSec 2
          $authReady = $localAuthResponse.ok -eq $true -and $localAuthResponse.projectId -eq "demo-peripherals-local"
          if ($authReady) { break }
        } catch {}
      }
      if (-not $authReady) {
        throw "Local employee-auth helper did not start. See $localAuthErrorLog."
      }
      Write-Host "Local employee sign-in helper is ready on port 5002."
    }

    Write-Host "Local test environment is already running at http://127.0.0.1:5000."
    return
  }

  $busyPorts = $listeningPorts -join ", "
  throw "Test environment ports are already in use ($busyPorts). Stop the existing process or resolve the port conflict before starting emulators."
}

if ($localAuthIsRunning) {
  $localAuthProcess = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -and
      $_.CommandLine.IndexOf($localAuthServer, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } |
    Select-Object -First 1
  if (-not $localAuthProcess) {
    throw "Port 5002 is serving the local employee-auth health response, but its process could not be verified."
  }
  Stop-Process -Id $localAuthProcess.ProcessId
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-NetTCPConnection -State Listen -LocalPort 5002 -ErrorAction SilentlyContinue)) { break }
  }
}
$localAuthPort = Get-NetTCPConnection -State Listen -LocalPort 5002 -ErrorAction SilentlyContinue
if ($localAuthPort) {
  throw "Port 5002 is in use by a service that is not the local employee-auth test helper."
}

$emulatorDataDir = Join-Path $PSScriptRoot ".firebase\test-data"
Write-Host "Emulator data will be imported from and saved to: $emulatorDataDir"
Write-Host "To save changes, press Ctrl+C and wait for emulator shutdown to finish before closing this terminal."
$emulatorArguments = @(
  "emulators:exec",
  "--ui",
  "--only", "hosting,auth,firestore",
  "--project", "demo-peripherals-local"
)
if (Test-Path (Join-Path $emulatorDataDir "firebase-export-metadata.json")) {
  $emulatorArguments += @("--import", $emulatorDataDir)
}
$emulatorArguments += @("--export-on-exit", $emulatorDataDir)
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$emulatorArguments += "`"$nodeExecutable`" `"$localAuthServer`""

& firebase @emulatorArguments
$firebaseExitCode = $LASTEXITCODE
if ($firebaseExitCode -ne 0) {
  throw "Firebase emulators exited with code $firebaseExitCode."
}