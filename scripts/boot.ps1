# Bring the public shop back after this computer restarts.
# Postgres stays on this computer (localhost:5433).
# Usage (from repo root):
#   .\scripts\boot.ps1            # start missing pieces
#   .\scripts\boot.ps1 -Install   # start at Windows logon
#   .\scripts\boot.ps1 -Uninstall

param(
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $Root "apps\api"
$Cloudflared = Join-Path $env:LOCALAPPDATA "WingerTools\cloudflared.exe"
$DataDir = Join-Path $env:USERPROFILE "WingerData"
$LogDir = Join-Path $DataDir "logs"
$HostFile = Join-Path $DataDir "public-host.txt"
$Config = Join-Path $DataDir "cloudflared\config.yml"
$WebRoot = Join-Path $Root "apps\winger\build\web"
$OriginJs = Join-Path $PSScriptRoot "public-origin.js"
$TaskName = "WingerPublicShop"
$UploadDir = if ($env:UPLOAD_DIR) { $env:UPLOAD_DIR } else { Join-Path $DataDir "uploads" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $UploadDir | Out-Null

function Write-BootLog([string]$Message) {
  $line = "{0:u} {1}" -f (Get-Date).ToUniversalTime(), $Message
  Add-Content -Path (Join-Path $LogDir "boot.log") -Value $line -Encoding utf8
  Write-Host $Message
}

function Test-LocalPort([int]$Port) {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", $Port)
    $tcp.Close()
    return $true
  } catch {
    return $false
  }
}

function Test-CommandLine([string]$Pattern) {
  $found = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match $Pattern
  }
  return [bool]$found
}

function Start-Hidden {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory
  )
  Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
}

function Wait-LocalPort([int]$Port, [int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-LocalPort $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Wait-Network {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $req = Invoke-WebRequest -UseBasicParsing -Uri "https://cloudflare.com" -TimeoutSec 4
      if ($req.StatusCode -ge 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-BootLog "Removed Windows logon task $TaskName"
  exit 0
}

if ($Install) {
  $script = Join-Path $PSScriptRoot "boot.ps1"
  $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = "PT45S"
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-BootLog "Windows will start the public shop at logon ($TaskName)"
}

Write-BootLog "Starting Winger public shop from $Root"
$env:UPLOAD_DIR = $UploadDir
$NodeHome = Join-Path $env:ProgramFiles "nodejs"
$Npm = Join-Path $NodeHome "npm.cmd"
$Node = Join-Path $NodeHome "node.exe"
if (-not (Test-Path $Npm)) { $Npm = "npm.cmd" }
if (-not (Test-Path $Node)) { $Node = "node.exe" }

if (-not (Test-LocalPort 5433)) {
  Write-BootLog "Starting embedded Postgres on 5433"
  Start-Hidden -FilePath $Npm -ArgumentList @("run", "db:pg") -WorkingDirectory $ApiDir
  if (-not (Wait-LocalPort 5433 90)) {
    Write-BootLog "Postgres did not open 5433"
    exit 1
  }
} else {
  Write-BootLog "Postgres already on 5433"
}

if (-not (Test-LocalPort 3000)) {
  Write-BootLog "Starting API on 3000"
  Start-Hidden -FilePath $Npm -ArgumentList @("run", "start:dev") -WorkingDirectory $ApiDir
  if (-not (Wait-LocalPort 3000 120)) {
    Write-BootLog "API did not open 3000"
    exit 1
  }
} else {
  Write-BootLog "API already on 3000"
}

if (-not (Test-Path $WebRoot)) {
  Write-BootLog "Web build is missing at $WebRoot"
  exit 1
}

if (-not (Test-LocalPort 8088)) {
  Write-BootLog "Starting public origin on 8088"
  Start-Hidden -FilePath $Node -ArgumentList @($OriginJs, $WebRoot) -WorkingDirectory $Root
  if (-not (Wait-LocalPort 8088 15)) {
    Write-BootLog "Public origin did not open 8088"
    exit 1
  }
} else {
  Write-BootLog "Public origin already on 8088"
}

$savedHost = "wingermarket.com"
if (Test-Path $HostFile) {
  $fromFile = (Get-Content $HostFile -Raw).Trim()
  if ($fromFile) { $savedHost = $fromFile }
}

if (-not (Test-Path $Cloudflared)) {
  Write-BootLog "cloudflared is missing at $Cloudflared"
  exit 1
}
if (-not (Test-Path $Config)) {
  Write-BootLog "Named tunnel config is missing. Run .\scripts\public.ps1 -Hostname $savedHost once."
  exit 1
}

if (Test-CommandLine "tunnel run winger") {
  Write-BootLog "Named tunnel already running"
} else {
  if (-not (Wait-Network)) {
    Write-BootLog "Network is not ready for Cloudflare yet; starting the tunnel anyway"
  }
  Write-BootLog "Starting named tunnel for https://$savedHost"
  Start-Hidden -FilePath $Cloudflared -ArgumentList @("--config", $Config, "--no-autoupdate", "tunnel", "run", "winger") -WorkingDirectory $Root
}

Write-BootLog "Public shop https://$savedHost"
exit 0
