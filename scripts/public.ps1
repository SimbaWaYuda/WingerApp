# Public shop + API on one HTTPS hostname. Postgres stays on this computer.
# Usage (from repo root):
#   .\scripts\public.ps1
# No domain yet: Tailscale Funnel keeps the same *.ts.net address after restart.
# When you have a domain on Cloudflare:
#   .\scripts\public.ps1 -Login
#   .\scripts\public.ps1 -Hostname winger.yourdomain.com

param(
  [switch]$Login,
  [string]$Hostname = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Cloudflared = Join-Path $env:LOCALAPPDATA "WingerTools\cloudflared.exe"
$Tailscale = "C:\Program Files\Tailscale\tailscale.exe"
$DataDir = Join-Path $env:USERPROFILE "WingerData\cloudflared"
$HostFile = Join-Path $env:USERPROFILE "WingerData\public-host.txt"
$WebRoot = Join-Path $Root "apps\winger\build\web"
$OriginJs = Join-Path $PSScriptRoot "public-origin.js"
$TunnelName = "winger"

New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE "WingerData") | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if (-not (Test-Path $WebRoot)) {
  Write-Error "Build the web app first."
}

function Start-PublicOrigin {
  $listening = Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Write-Host "Public origin already on 127.0.0.1:8088"
    return
  }
  Start-Process -FilePath "node" -ArgumentList @($OriginJs, $WebRoot) -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 1
  Write-Host "Public origin http://127.0.0.1:8088"
}

if ($Login) {
  if (-not (Test-Path $Cloudflared)) {
    Write-Error "cloudflared is missing at $Cloudflared"
  }
  Write-Host "Opening Cloudflare so a named tunnel can use your domain."
  & $Cloudflared tunnel login
  exit $LASTEXITCODE
}

if ($Hostname) {
  Set-Content -Path $HostFile -Value $Hostname.Trim() -Encoding ascii
}

$savedHost = ""
if (Test-Path $HostFile) {
  $savedHost = (Get-Content $HostFile -Raw).Trim()
}

if ($savedHost) {
  if (-not (Test-Path $Cloudflared)) {
    Write-Error "cloudflared is missing at $Cloudflared"
  }
  $Cert = Join-Path $env:USERPROFILE ".cloudflared\cert.pem"
  if (-not (Test-Path $Cert)) {
    Write-Error "Cloudflare is not signed in. Run .\scripts\public.ps1 -Login"
  }

  $tunnels = & $Cloudflared tunnel list --output json 2>$null
  $hasTunnel = $false
  if ($tunnels) {
    try {
      $parsed = $tunnels | ConvertFrom-Json
      $hasTunnel = @($parsed | Where-Object { $_.name -eq $TunnelName }).Count -gt 0
    } catch {
      $hasTunnel = (& $Cloudflared tunnel list) -match "\s$TunnelName\s"
    }
  }
  if (-not $hasTunnel) {
    Write-Host "Creating named tunnel $TunnelName"
    & $Cloudflared tunnel create $TunnelName
  }

  $tunnelId = $null
  foreach ($line in (& $Cloudflared tunnel list)) {
    if ($line -match "^([0-9a-f-]{36})\s+$TunnelName\b") {
      $tunnelId = $Matches[1]
      break
    }
  }
  if (-not $tunnelId) {
    Write-Error "Could not read the $TunnelName tunnel id."
  }

  $cred = Join-Path $env:USERPROFILE ".cloudflared\$tunnelId.json"
  $config = Join-Path $DataDir "config.yml"
  @"
tunnel: $tunnelId
credentials-file: $(($cred -replace '\\','/'))
protocol: http2
ingress:
  - hostname: $savedHost
    service: http://127.0.0.1:8088
  - service: http_status:404
"@ | Set-Content -Path $config -Encoding ascii

  Write-Host "Pointing $savedHost at tunnel $TunnelName"
  & $Cloudflared tunnel route dns --overwrite-dns $TunnelName $savedHost
  Start-PublicOrigin
  Write-Host "Public shop https://$savedHost"
  & $Cloudflared --config $config --no-autoupdate tunnel run $TunnelName
  exit $LASTEXITCODE
}

if (-not (Test-Path $Tailscale)) {
  Write-Error "Tailscale is missing. Install Tailscale.Tailscale, or pass -Hostname once a domain is on Cloudflare."
}

$status = & $Tailscale status 2>&1 | Out-String
if ($status -match "Logged out") {
  Write-Host "Sign in to Tailscale in the browser window, then run .\scripts\public.ps1 again."
  & $Tailscale login
  exit $LASTEXITCODE
}

Start-PublicOrigin
& $Tailscale funnel --bg --https=443 http://127.0.0.1:8088
& $Tailscale funnel status
