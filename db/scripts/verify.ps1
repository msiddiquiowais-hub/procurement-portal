# verify.ps1 — Windows PowerShell variant of verify.sh.
# Runs verify.sh inside the procurement-portal-db container (where bash + psql are available).
$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script    = Join-Path $root 'db/scripts/verify.sh'
$container = 'procurement-portal-db'

docker cp $script "${container}:/tmp/verify.sh" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker cp failed" }
docker exec -w /tmp $container bash -c "DB_HOST='' DB_PORT=5432 bash /tmp/verify.sh"
if ($LASTEXITCODE -ne 0) { Write-Host "Verify: FAIL" -ForegroundColor Red; exit 1 }
