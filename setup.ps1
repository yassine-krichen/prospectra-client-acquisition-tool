<#
.SYNOPSIS
    Sets up biz-scraper for local development: verifies prerequisites, creates
    .env with generated secrets, installs dependencies, generates the Prisma
    client, runs migrations against your Neon database(s), and runs the test
    suite.

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

Write-Host "==> Configuring environment" -ForegroundColor Cyan

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "  Created .env from .env.example"

    $sessionSecret = New-RandomSecret -Bytes 32
    $cronSecret = New-RandomSecret -Bytes 32

    $envContent = Get-Content .env -Raw
    $envContent = $envContent -replace 'SESSION_SECRET=""', "SESSION_SECRET=`"$sessionSecret`""
    $envContent = $envContent -replace 'CRON_SECRET=""', "CRON_SECRET=`"$cronSecret`""
    Set-Content -Path .env -Value $envContent -NoNewline

    Write-Host "  Generated SESSION_SECRET and CRON_SECRET"
    Write-Host ""
    Write-Host "  DATABASE_URL still needs your Neon connection string" -ForegroundColor Yellow
    Write-Host "  (create a free project at https://neon.tech) before continuing." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  After that, provision the two accounts (Noel / EvilWithin) by calling" -ForegroundColor Yellow
    Write-Host "  POST /api/cron/seed-users once, with header x-cron-secret: <CRON_SECRET>." -ForegroundColor Yellow
    Write-Host "  Each account sets its own password on its first login at /login." -ForegroundColor Yellow
} else {
    Write-Host "  .env already exists - leaving it untouched"
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

Write-Host "==> Running test suite" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) {
    Write-Host "Tests failed - setup finished but something's off. Check output above." -ForegroundColor Yellow
} else {
    Write-Host "  All tests passing"
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "  Run 'npm run dev' and open http://localhost:3000"
Write-Host "  Only DATABASE_URL / SESSION_SECRET / CRON_SECRET are required."
Write-Host "  Everything else in .env (Gemini, Groq, Resend, Hunter, ...) is optional - add keys as you provision each service. See README.md > Configuration."
