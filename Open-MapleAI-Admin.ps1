param(
  [switch]$Stop
)

$ErrorActionPreference = "Stop"
$tunnelDirectory = Join-Path $env:LOCALAPPDATA "MapleAIAdminTunnel"
$pidFile = Join-Path $tunnelDirectory "ssh.pid"
$sshKey = Join-Path $env:USERPROFILE ".ssh\hermes_vds_transfer"
$sshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
$tunnelArguments = "4031:127.0.0.1:4031"
$server = "root@31.77.207.76"

if ($Stop) {
  if (-not (Test-Path $pidFile)) {
    Write-Host "No MapleAI admin tunnel is recorded."
    exit 0
  }

  $tunnelPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $tunnelPid" -ErrorAction SilentlyContinue
  if ($process -and $process.Name -eq "ssh.exe" -and
      $process.CommandLine.Contains("31.77.207.76") -and
      $process.CommandLine.Contains($tunnelArguments)) {
    Stop-Process -Id $tunnelPid -Force
    Write-Host "MapleAI admin tunnel stopped."
  } else {
    Write-Host "The recorded SSH tunnel is not running."
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

if (-not (Test-Path $sshKey)) {
  throw "SSH identity not found: $sshKey"
}

try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:4031/login" -TimeoutSec 2 -UseBasicParsing
  if ($response.StatusCode -eq 200) {
    Start-Process "http://localhost:4031/login"
    Write-Host "MapleAI admin is already reachable at http://localhost:4031/login"
    exit 0
  }
} catch {
  # No local tunnel is listening yet.
}

New-Item -ItemType Directory -Path $tunnelDirectory -Force | Out-Null
$keyArgument = '"' + $sshKey + '"'
$arguments = @(
  "-N",
  "-L", $tunnelArguments,
  "-i", $keyArgument,
  "-o", "BatchMode=yes",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  $server
)

$sshProcess = Start-Process -FilePath $sshPath -ArgumentList $arguments -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $sshProcess.Id -NoNewline

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ($sshProcess.HasExited) { break }
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:4031/login" -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    # Wait for the SSH forward and upstream app to accept connections.
  }
}

if (-not $ready) {
  if (-not $sshProcess.HasExited) { Stop-Process -Id $sshProcess.Id -Force }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  throw "Could not reach MapleAI admin on localhost:4031. Check the SSH connection and try again."
}

Start-Process "http://localhost:4031/login"
Write-Host "MapleAI admin opened at http://localhost:4031/login"
Write-Host "Close the tunnel with: Open-MapleAI-Admin.ps1 -Stop"
