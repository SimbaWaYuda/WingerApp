# Smoke-test STORAGE_DRIVER=s3 against local MinIO.
# Prerequisites: Docker Desktop running.
# From apps/api: .\scripts\minio-smoke.ps1

$ErrorActionPreference = "Stop"
$ApiDir = Split-Path -Parent $PSScriptRoot
Set-Location $ApiDir

Write-Host "Starting MinIO..."
docker compose -f docker-compose.minio.yml up -d

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 9000)
    $tcp.Close()
    $ready = $true
    break
  } catch {}
}
if (-not $ready) { Write-Error "MinIO did not become ready on :9000" }

$env:STORAGE_DRIVER = "s3"
$env:S3_BUCKET = "winger-uploads"
$env:S3_REGION = "us-east-1"
$env:S3_ENDPOINT = "http://127.0.0.1:9000"
$env:S3_PUBLIC_BASE_URL = "http://127.0.0.1:9000/winger-uploads"
$env:S3_FORCE_PATH_STYLE = "true"
$env:AWS_ACCESS_KEY_ID = "winger"
$env:AWS_SECRET_ACCESS_KEY = "wingersecret"

Write-Host "Running create-bucket + put/get smoke..."
npx ts-node --transpile-only scripts/minio-smoke.ts

Write-Host "MinIO console: http://127.0.0.1:9001 (winger / wingersecret)"
Write-Host "To point Nest at MinIO, copy the S3_* vars into apps/api/.env and restart."
