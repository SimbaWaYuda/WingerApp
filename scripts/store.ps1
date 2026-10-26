# Phone builds that talk to https://wingermarket.com.
# Usage (from repo root):
#   .\scripts\store.ps1           # Android APK for sideload / Play internal testers
# TestFlight needs a Mac and an Apple Developer team. Bundle id is com.winger.winger.

param(
  [ValidateSet("apk", "appbundle")]
  [string]$Android = "apk"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $Root "apps\winger"
$Flutter = "C:\Users\wmsuy\S3 POS+\s3_pos_plus_flutter\flutter\bin\flutter.bat"
$OutDir = Join-Path $env:USERPROFILE "WingerData\store"
$Api = "https://wingermarket.com"

if (-not (Test-Path $Flutter)) {
  Write-Error "Flutter SDK is missing at $Flutter"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Set-Location $AppDir

if ($Android -eq "appbundle") {
  & $Flutter build appbundle --release "--dart-define=API_BASE_URL=$Api"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $built = Join-Path $AppDir "build\app\outputs\bundle\release\app-release.aab"
  $dest = Join-Path $OutDir "winger.aab"
} else {
  & $Flutter build apk --release "--dart-define=API_BASE_URL=$Api"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $built = Join-Path $AppDir "build\app\outputs\flutter-apk\app-release.apk"
  $dest = Join-Path $OutDir "winger.apk"
}

Copy-Item -LiteralPath $built -Destination $dest -Force
Write-Host "Android package $dest"
Write-Host "Application id com.winger.winger talks to $Api"
Write-Host "TestFlight: build the iOS app on a Mac with bundle id com.winger.winger and the same API_BASE_URL."
