<#
  Tracepipe local demo (Windows). Installs, builds and starts everything, creates a
  "Demo shop" project, runs the instrumented demo shop with live traffic, and opens the
  dashboard.

    powershell -ExecutionPolicy Bypass -File scripts\demo\start-demo.ps1
    powershell -ExecutionPolicy Bypass -File scripts\demo\start-demo.ps1 -SkipInstall   # faster re-run

  Stop everything:  powershell -ExecutionPolicy Bypass -File scripts\demo\stop-demo.ps1
  Written for Windows PowerShell 5.1 (built into Windows) and PowerShell 7.
#>
param(
  [switch]$SkipInstall,
  [int]$TrafficMinutes = 30,
  [int]$RequestsPerSecond = 2
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Data = Join-Path $Root 'apps\collector\data'
$Base = 'http://localhost:4318'

function Step([string]$m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host ''; Write-Host "ERROR: $m" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
function Run([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). Scroll up for the reason." }
}

Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not installed. Install Node.js 22 LTS or newer from https://nodejs.org (or run: winget install OpenJS.NodeJS.LTS), open a new PowerShell window and run this again.'
}
$nodeVersion = [version]((node -v).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'22.13.0') {
  Fail "Node.js $nodeVersion is too old: Tracepipe needs 22.13 or newer (it uses the built-in SQLite). Run: winget install OpenJS.NodeJS.LTS"
}
Write-Host "Node.js $nodeVersion"

Step 'Checking that ports 4318, 3000, 4101 and 4102 are free'
foreach ($port in 4318, 3000, 4101, 4102) {
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($busy) { Fail "Port $port is already in use. If a previous demo is running, stop it with scripts\demo\stop-demo.ps1 and try again." }
}

if (-not $SkipInstall) {
  Push-Location $Root
  Step 'Installing packages (first run takes a few minutes)'
  Run 'npm install' { npm install --no-audit --no-fund }
  Step 'Building the dashboard'
  Run 'Dashboard build' { npm run build:web }
  Pop-Location
  Push-Location (Join-Path $Root 'examples\demo-shop')
  Step 'Installing the demo shop (with OpenTelemetry)'
  Run 'Demo shop install' { npm install --no-audit --no-fund }
  Pop-Location
}
if (-not (Test-Path (Join-Path $Root 'apps\web\dist\index.html'))) { Fail 'The dashboard is not built. Run again without -SkipInstall.' }

New-Item -ItemType Directory -Force -Path $Data | Out-Null

# Optional GitHub App settings (sign in with GitHub, pull requests): .env.demo at the repo root.
$extraEnv = ''
$githubOn = $false
$envDemo = Join-Path $Root '.env.demo'
if (Test-Path $envDemo) {
  Step 'Reading GitHub App settings from .env.demo'
  foreach ($raw in Get-Content $envDemo) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#') -or -not $line.Contains('=')) { continue }
    $i = $line.IndexOf('=')
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim().Trim('"').Trim("'")
    if ($v -eq '') { continue }
    if ($k -eq 'GITHUB_APP_PRIVATE_KEY_FILE') {
      $kp = if ([System.IO.Path]::IsPathRooted($v)) { $v } else { Join-Path $Root $v }
      if (-not (Test-Path $kp)) { Fail "GITHUB_APP_PRIVATE_KEY_FILE points to $kp, which does not exist. Put the downloaded .pem there." }
      $v = (Resolve-Path $kp).Path
    }
    if ($k -eq 'GITHUB_CLIENT_ID') { $githubOn = $true }
    $extraEnv += "set `"$k=$v`"`r`n"
  }
  Push-Location $Root
  node scripts\demo\check-github.js
  if ($LASTEXITCODE -ne 0) { Write-Host 'Continuing anyway: development sign-in still works, but fix the FIX lines for GitHub sign-in and pull requests.' -ForegroundColor Yellow }
  Pop-Location
}

Step 'Starting the collector (its own window)'
$collectorCmd = Join-Path $Data 'run-collector.cmd'
@"
@echo off
title Tracepipe collector - close this window to stop it
cd /d "$Root\apps\collector"
set DEV_LOGIN=true
set WEB_DIST=$Root\apps\web\dist
set WEB_ORIGIN=$Base
set PUBLIC_URL=$Base
$extraEnv
node src\server.js
echo.
echo The collector stopped.
pause
"@ | Set-Content -Encoding ASCII -Path $collectorCmd
Start-Process -FilePath $collectorCmd

$up = $false
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-RestMethod -Uri "$Base/livez" -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep -Seconds 1 }
}
if (-not $up) { Fail 'The collector did not start within 60 seconds. Look at its window for the reason.' }
Write-Host "Collector is up at $Base"

Step 'Creating the demo user and project'
$csrf = @{ 'x-requested-with' = 'tracepipe' }
$login = Invoke-RestMethod -Method Post -Uri "$Base/api/auth/dev-login" -Headers $csrf -ContentType 'application/json' -Body '{"login":"demo"}'
$auth = @{ 'authorization' = "Bearer $($login.access_token)" }
$list = Invoke-RestMethod -Uri "$Base/api/projects" -Headers $auth
$project = $list.projects | Where-Object { $_.name -eq 'Demo shop' } | Select-Object -First 1
if ($project) {
  $projectId = $project.id
  $key = (Invoke-RestMethod -Method Post -Uri "$Base/api/projects/$projectId/keys" -Headers $auth -ContentType 'application/json' -Body '{"label":"demo run"}').key.value
} else {
  $created = Invoke-RestMethod -Method Post -Uri "$Base/api/projects" -Headers $auth -ContentType 'application/json' -Body '{"name":"Demo shop"}'
  $projectId = $created.project.id
  $key = $created.key.value
}
$verifyToken = (Invoke-RestMethod -Uri "$Base/api/projects/$projectId/loadtests/limits" -Headers $auth).verify_token
Write-Host "Project $projectId"

Step 'Starting the demo shop (gateway -> orders -> payments, instrumented with OpenTelemetry)'
$shopCmd = Join-Path $Data 'run-demo-shop.cmd'
@"
@echo off
title Demo shop on http://localhost:3000 - close this window to stop it
cd /d "$Root\examples\demo-shop"
set PORT=3000
set OTEL_EXPORTER_OTLP_ENDPOINT=$Base
set OTEL_EXPORTER_OTLP_HEADERS=x-api-key=$key
set OTEL_PIPELINE_VERIFY_TOKEN=$verifyToken
node src\start.js
echo.
echo The demo shop stopped.
pause
"@ | Set-Content -Encoding ASCII -Path $shopCmd
Start-Process -FilePath $shopCmd

$shopUp = $false
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-RestMethod -Uri 'http://localhost:3000/healthz' -TimeoutSec 2 | Out-Null; $shopUp = $true; break } catch { Start-Sleep -Seconds 1 }
}
if (-not $shopUp) { Fail 'The demo shop did not start within 60 seconds. Look at its window for the reason.' }

Step "Sending checkout traffic for $TrafficMinutes minutes"
$trafficCmd = Join-Path $Data 'run-traffic.cmd'
$seconds = $TrafficMinutes * 60
@"
@echo off
title Demo traffic - close this window to stop it
cd /d "$Root\examples\demo-shop"
node src\traffic.js http://localhost:3000 $RequestsPerSecond $seconds
pause
"@ | Set-Content -Encoding ASCII -Path $trafficCmd
Start-Process -FilePath $trafficCmd

Start-Process "$Base/login?next=%2Fp%2F$projectId%2Foverview"

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' Tracepipe demo is running' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host " Dashboard:   $Base   (opened in your browser)"
if ($githubOn) { Write-Host ' Sign in:     Sign in with GitHub (or Development sign-in, name: demo)' }
else { Write-Host ' Sign in:     Development sign-in, name: demo   (add .env.demo for GitHub sign-in)' }
Write-Host " Project:     Demo shop  ($Base/p/$projectId/overview)"
Write-Host ' Demo shop:   http://localhost:3000   (try /api/products)'
Write-Host ''
Write-Host ' Demo ideas:'
Write-Host '  - Overview: the live pipeline strip; "Traces that need attention"'
Write-Host '  - Traces > Errors: open one, click "charge card" to see the exception'
Write-Host '  - Load test: http://127.0.0.1:3000/api/products, Check access, Start'
Write-Host '  - Pipeline admin: turn on "Storage goes down", watch Store, turn it off'
Write-Host ''
Write-Host ' Stop everything: scripts\demo\stop-demo.ps1 (or close the three windows)'
Write-Host ''
