# migrate.ps1 — Windows PowerShell variant of migrate.sh
# Applies all *.sql files in db/migrations in lexical order via `docker cp` +
# `docker exec psql`, since `bash` is not on PATH in many PowerShell sessions.
#
# Usage: pwsh db/scripts/migrate.ps1
#        or: powershell -File db/scripts/migrate.ps1

$ErrorActionPreference = 'Continue'
$root      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$migDir    = Join-Path $root 'db/migrations'
$container = 'procurement-portal-db'

if (-not (Test-Path $migDir)) { throw "migrations directory not found: $migDir" }
$dockerOk = docker ps --format '{{.Names}}' | Select-String -SimpleMatch $container -Quiet
if (-not $dockerOk) { throw "container '$container' is not running. Start it first: docker compose -f db/docker/docker-compose.yml up -d" }

$dbHost = $env:DB_HOST    ; if (-not $dbHost) { $dbHost = 'localhost' }
$dbPort = $env:DB_PORT    ; if (-not $dbPort) { $dbPort = '55432' }
$dbUser = $env:DB_USER    ; if (-not $dbUser) { $dbUser = 'proc' }
$dbName = $env:DB_NAME    ; if (-not $dbName) { $dbName = 'procurementDB' }

Write-Host "Applying migrations to ${dbUser}@${dbHost}:${dbPort}/${dbName}"
$ok = 0; $fail = 0; $failed = @()
Get-ChildItem -LiteralPath $migDir -Filter '*.sql' | Sort-Object Name | ForEach-Object {
  $remote = '/tmp/' + $_.BaseName + '.sql'
  Write-Host ("  - " + $_.Name.PadRight(48)) -NoNewline
  # docker cp; capture both streams and ignore the LocalActionPreference trap
  $null = & docker cp $_.FullName "${container}:${remote}" 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host " cp-FAIL" -ForegroundColor Red
    $fail++; $failed += $_.Name
    return
  }
  # psql via docker exec. Use -X (no .psqlrc), -A (aligned off), -t (tuples only
  # would suppress too much), -q (quiet), -v ON_ERROR_STOP=1.
  $psqlOut = & docker exec -e PGOPTIONS='--client-min-messages=warning' $container psql -U $dbUser -d $dbName -X -A -q -v ON_ERROR_STOP=1 -f $remote 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host " OK" -ForegroundColor Green
    $ok++
  } else {
    Write-Host " FAIL" -ForegroundColor Red
    $fail++; $failed += $_.Name
    $psqlOut | Select-Object -Last 8 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkRed }
  }
}
Write-Host "---"
Write-Host ("Done. OK={0} FAIL={1}" -f $ok, $fail)
if ($fail -gt 0) {
  Write-Host ("Failed: " + ($failed -join ', ')) -ForegroundColor Red
  exit 1
}
