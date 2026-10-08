# seed.ps1 — Windows PowerShell variant of seed.sh
$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$seed      = Join-Path $root 'db/seeds/seed.sql'
$container = 'procurement-portal-db'

$dbUser = $env:DB_USER; if (-not $dbUser) { $dbUser = 'proc' }
$dbName = $env:DB_NAME; if (-not $dbName) { $dbName = 'procurementDB' }

docker cp $seed "${container}:/tmp/seed.sql" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker cp failed" }
docker exec $container psql -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -q -f /tmp/seed.sql 2>&1 | Select-Object -Last 20
if ($LASTEXITCODE -eq 0) { Write-Host "Seed: OK" -ForegroundColor Green } else { Write-Host "Seed: FAIL" -ForegroundColor Red; exit 1 }
