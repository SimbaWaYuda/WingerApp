# Winger one-command local stack (Windows): embedded Postgres + Nest API + Flutter.
# Usage (from repo root):
#   .\scripts\dev.ps1
#   .\scripts\dev.ps1 -Device chrome
#   .\scripts\dev.ps1 -SkipFlutter
#   .\scripts\dev.ps1 -SetupDb

param(
  [string]$Device = "windows",
  [switch]$SkipFlutter,
  [switch]$SetupDb
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $Root "apps\api"
$AppDir = Join-Path $Root "apps\winger"

if (-not (Test-Path (Join-Path $ApiDir "package.json"))) {
  Write-Error "Could not find apps/api. Run from the Winger App repo."
}

# Durable uploads outside the repo tree (survives clean/rebuild).
if (-not $env:UPLOAD_DIR) {
  $env:UPLOAD_DIR = Join-Path $env:USERPROFILE "WingerData\uploads"
}
New-Item -ItemType Directory -Force -Path $env:UPLOAD_DIR | Out-Null

$envFile = Join-Path $ApiDir ".env"
$envExample = Join-Path $ApiDir ".env.example"
if (-not (Test-Path $envFile)) {
  if (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Host "Created apps/api/.env from .env.example"
  } else {
    Write-Error "Missing apps/api/.env and .env.example"
  }
}

Push-Location $ApiDir
try {
  if (-not (Test-Path "node_modules")) {
    Write-Host "Installing API dependencies..."
    npm install
  }

  $pgMarker = Join-Path $ApiDir ".pgdata\PG_VERSION"
  if ($SetupDb -or -not (Test-Path $pgMarker)) {
    Write-Host "Starting Postgres briefly for first-time db:setup..."
    $pgJob = Start-Job -ScriptBlock {
      param($dir)
      Set-Location $dir
      npm run db:pg
    } -ArgumentList $ApiDir

    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 1
      try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", 5433)
        $tcp.Close()
        $ready = $true
        break
      } catch {}
    }
    if (-not $ready) {
      Stop-Job $pgJob -ErrorAction SilentlyContinue
      Remove-Job $pgJob -Force -ErrorAction SilentlyContinue
      Write-Error "Embedded Postgres did not become ready on port 5433"
    }

    Write-Host "Running prisma migrate + seed..."
    npm run db:migrate:deploy
    npm run prisma:seed

    Stop-Job $pgJob -ErrorAction SilentlyContinue
    Remove-Job $pgJob -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }

  Write-Host "Starting Postgres + API (UPLOAD_DIR=$env:UPLOAD_DIR)..."
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "cd `"$ApiDir`"; `$env:UPLOAD_DIR='$env:UPLOAD_DIR'; npm run dev:api"
  ) | Out-Null
}
finally {
  Pop-Location
}

Write-Host "Waiting for API health..."
$apiReady = $false
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  try {
    $resp = Invoke-WebRequest -Uri "http://localhost:3000/health" -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) {
      $apiReady = $true
      break
    }
  } catch {}
}
if (-not $apiReady) {
  Write-Warning "API health check timed out — Flutter may start offline. Check the API window."
} else {
  Write-Host "API is up at http://localhost:3000"
}

if ($SkipFlutter) {
  Write-Host "Skipping Flutter (-SkipFlutter)."
  exit 0
}

Push-Location $AppDir
try {
  Write-Host "Launching Flutter ($Device)..."
  flutter pub get
  flutter run -d $Device
}
finally {
  Pop-Location
}
