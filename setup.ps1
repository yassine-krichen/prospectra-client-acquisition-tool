<#
.SYNOPSIS
    Sets up biz-scraper for local development: verifies prerequisites, creates
    .env with generated secrets, starts Postgres, installs dependencies,
    generates the Prisma client, runs migrations, and runs the test suite.

.EXAMPLE
    ./setup.ps1
#>

$ErrorActionPreference = 'Stop'

function Test-CommandExists {
    param([Parameter(Mandatory)][string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function New-RandomSecret {
    param([int]$Bytes = 32)
    $buffer = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
    return [Convert]::ToBase64String($buffer) -replace '[+/=]', ''
}

Write-Host "==> Checking prerequisites" -ForegroundColor Cyan

if (-not (Test-CommandExists node)) {
    Write-Error "Node.js not found. Install Node >= 20 from https://nodejs.org and re-run this script."
}

$nodeVersion = (node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Error "Node $nodeVersion found, but this project requires Node >= 20."
}
Write-Host "  Node $nodeVersion OK"

if (-not (Test-CommandExists npm)) {
    Write-Error "npm not found (it should ship with Node)."
}
Write-Host "  npm OK"

$hasDocker = Test-CommandExists docker
if (-not $hasDocker) {
    Write-Host "  Docker not found — DATABASE_URL in .env must point at a Postgres instance you provide yourself." -ForegroundColor Yellow
} else {
    Write-Host "  Docker OK"
}

Write-Host "==> Configuring environment" -ForegroundColor Cyan

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "  Created .env from .env.example"

    $sessionSecret = New-RandomSecret -Bytes 32
    $cronSecret = New-RandomSecret -Bytes 32
    $dashboardPassword = New-RandomSecret -Bytes 9

    $envContent = Get-Content .env -Raw
    $envContent = $envContent -replace 'SESSION_SECRET=""', "SESSION_SECRET=`"$sessionSecret`""
    $envContent = $envContent -replace 'CRON_SECRET=""', "CRON_SECRET=`"$cronSecret`""
    $envContent = $envContent -replace 'DASHBOARD_PASSWORD=""', "DASHBOARD_PASSWORD=`"$dashboardPassword`""
    Set-Content -Path .env -Value $envContent -NoNewline

    Write-Host "  Generated SESSION_SECRET, CRON_SECRET, and DASHBOARD_PASSWORD"
    Write-Host ""
    Write-Host "  Dashboard password: $dashboardPassword" -ForegroundColor Green
    Write-Host "  (also saved in .env — this is printed once)" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "  .env already exists — leaving it untouched"
}

if ($hasDocker) {
    Write-Host "==> Starting Postgres (docker compose)" -ForegroundColor Cyan
    docker compose up -d

    Write-Host "  Waiting for Postgres to accept connections..."
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        docker compose exec -T postgres pg_isready -U postgres *>$null
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        Write-Error "Postgres did not become ready in time. Check 'docker compose logs postgres'."
    }
    Write-Host "  Postgres is ready"
}

Write-Host "==> Installing dependencies" -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed." }

Write-Host "==> Generating Prisma client" -ForegroundColor Cyan
npx prisma generate
if ($LASTEXITCODE -ne 0) { Write-Error "prisma generate failed." }

Write-Host "==> Running migrations" -ForegroundColor Cyan
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Write-Error "prisma migrate deploy failed. Check DATABASE_URL in .env." }

if ($hasDocker) {
    Write-Host "==> Migrating test database" -ForegroundColor Cyan
    # vitest.setup.ts points integration tests at a separate biz_scraper_test
    # database (falls back to it whenever DATABASE_URL isn't already set in
    # the process env) so tests never touch dev data. It needs its own copy
    # of the schema, migrated independently of the dev DATABASE_URL above.
    docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE biz_scraper_test" *>$null
    $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/biz_scraper_test?schema=public"
    npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { Write-Error "prisma migrate deploy failed against biz_scraper_test." }
    Remove-Item Env:\DATABASE_URL
}

Write-Host "==> Running test suite" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) {
    Write-Host "Tests failed — setup finished but something's off. Check output above." -ForegroundColor Yellow
} else {
    Write-Host "  All tests passing"
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "  Run 'npm run dev' and open http://localhost:3000"
Write-Host "  Only DATABASE_URL / DASHBOARD_PASSWORD / SESSION_SECRET / CRON_SECRET are required."
Write-Host "  Everything else in .env (Gemini, Groq, Resend, Hunter, ...) is optional — add keys as you provision each service. See README.md > Configuration."
