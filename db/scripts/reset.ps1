# reset.ps1 — Windows PowerShell variant of reset.sh
# Drop and recreate the database, then re-apply all migrations + the seed.
# DESTROYS ALL DATA. Dev only.
#
# Usage:  .\db\scripts\reset.ps1
#   or:  powershell -File db\scripts\reset.ps1
#
# `pwsh` is not on this machine (Windows PowerShell 5.1 only). Run from
# PowerShell with the call operator, or via powershell -File.
#
# ── WHY THIS FILE LOOKS CAREFUL ──────────────────────────────────────────────
# 1. THE DATABASE NAME MUST BE QUOTED IN SQL.
#    Unquoted identifiers fold to lowercase, so
#        DROP DATABASE IF EXISTS procurementDB
#    targets "procurementdb" — a DIFFERENT database from "procurementDB",
#    which is what psql -d procurementDB actually connects to. That bug made
#    the reset silently drop and recreate an empty decoy while the real
#    database kept every stale row, and the next run then failed on
#    pre-existing data as if it were a migration bug.
#    Every DROP/CREATE below uses an explicitly quoted identifier.
#
# 2. VERIFY THE POSTCONDITION, DON'T TRUST psql's EXIT CODE.
#    A no-op reset once reported success. We now assert the row counts.
#
# 3. RETRY THE DROP.
#    The API and the Next apps hold connections and reconnect, which races
#    DROP DATABASE. Terminate backends, then retry.

$ErrorActionPreference = 'Continue'
$root      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$container = 'procurement-portal-db'

$dbUser = $env:DB_USER; if (-not $dbUser) { $dbUser = 'proc' }
$dbName = $env:DB_NAME; if (-not $dbName) { $dbName = 'procurementDB' }
# Explicitly quoted identifier for use inside SQL. This is the whole point.
$q = '"' + $dbName + '"'

$dockerOk = docker ps --format '{{.Names}}' | Select-String -SimpleMatch $container -Quiet
if (-not $dockerOk) {
  throw "container '$container' is not running. Start it first: docker compose -f db/docker/docker-compose.yml up -d"
}

function Invoke-Psql {
  param([string]$Database, [string]$Sql, [switch]$Quiet)
  # -t (tuples only) + -A (unaligned) matter: with the default aligned output a
  # value query also emits a header, a ---- rule and an "(N rows)" footer, and
  # naive parsing reads the column NAME as a database name and the row count as
  # the value. Everything below parses stdout, so it must be bare values.
  $out = & docker exec $container psql -U $dbUser -d $Database -X -q -t -A -v ON_ERROR_STOP=1 -c $Sql 2>&1
  $code = $LASTEXITCODE
  if (-not $Quiet -and $out) { $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
  return @{ code = $code; out = ($out | Out-String) }
}

# Dropping/creating a database needs a QUOTED identifier, and PowerShell 5.1
# strips embedded double quotes out of arguments passed to native executables —
# so the statement silently degrades to the unquoted (lowercase-folded) form
# and hits the wrong database. Verified failure:
#   NOTICE: database "procurementdb" does not exist, skipping
# The fix is to stop putting the statement on the command line at all: write it
# to a file and feed psql's stdin, which is a byte-exact path with no shell
# quote processing. This is the same redirection the verify scripts use.
function Invoke-PsqlFile {
  param([string]$Database, [string]$Sql, [switch]$Quiet)
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("proc_reset_" + [guid]::NewGuid().ToString('N') + ".sql")
  [System.IO.File]::WriteAllText($tmp, $Sql, (New-Object System.Text.UTF8Encoding $false))
  try {
    $out = & cmd /c "docker exec -i $container psql -U $dbUser -d $Database -X -q -t -A -v ON_ERROR_STOP=1 -f - < `"$tmp`"" 2>&1
    $code = $LASTEXITCODE
    if (-not $Quiet -and $out) { $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    return @{ code = $code; out = ($out | Out-String) }
  } finally {
    if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}

# ── 0 · sweep case-mismatched decoys ────────────────────────────────────────
# A previous buggy reset left an empty "procurementdb" behind. Any database
# whose name case-insensitively matches ours but is not byte-identical is a
# decoy that will silently absorb future unquoted DROP/CREATE statements.
$find = Invoke-Psql -Database 'postgres' -Quiet `
  -Sql "SELECT datname FROM pg_database WHERE lower(datname) = lower('$dbName') AND datname <> '$dbName';"
$decoys = @($find.out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*$' })
foreach ($d in $decoys) {
  $null = Invoke-Psql -Database 'postgres' -Sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$d';" -Quiet
  $r = Invoke-PsqlFile -Database 'postgres' -Quiet -Sql ("DROP DATABASE IF EXISTS " + $q + ";")
  if ($r.code -eq 0) {
    Write-Host ("Removed case-mismatched decoy database '{0}'." -f $d) -ForegroundColor Yellow
  } else {
    Write-Host ("Could not remove decoy '{0}': {1}" -f $d, $r.out.Trim()) -ForegroundColor Yellow
  }
}

# ── 1 · drop, with retries against the app reconnect race ───────────────────
$dropped = $false
for ($attempt = 1; $attempt -le 5; $attempt++) {
  $null = Invoke-Psql -Database $dbName -Sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$dbName' AND pid <> pg_backend_pid();" -Quiet
  $r = Invoke-PsqlFile -Database 'postgres' -Sql ("DROP DATABASE IF EXISTS " + $q + ";") -Quiet
  if ($r.code -eq 0) { $dropped = $true; break }
  Write-Host ("  drop attempt {0}/5 failed: {1}" -f $attempt, $r.out.Trim()) -ForegroundColor Yellow
  Start-Sleep -Seconds 2
}
if (-not $dropped) { Write-Host "DROP DATABASE `"$dbName`" failed after 5 attempts" -ForegroundColor Red; exit 1 }
Write-Host "Dropped database `"$dbName`"."

# Prove it is gone before recreating, so we cannot silently continue on the
# old database.
$still = Invoke-Psql -Database 'postgres' -Quiet -Sql "SELECT count(*) FROM pg_database WHERE datname = '$dbName';"
$stillCount = ($still.out -replace '[^0-9]', '')
if ($stillCount -ne '0') {
  Write-Host ("Database still exists after DROP (count={0}) - aborting rather than continuing." -f $stillCount) -ForegroundColor Red
  exit 1
}

# ── 2 · create ─────────────────────────────────────────────────────────────
$r = Invoke-PsqlFile -Database 'postgres' -Quiet -Sql ("CREATE DATABASE " + $q + ";")
if ($r.code -ne 0) { Write-Host ("CREATE DATABASE failed: " + $r.out.Trim()) -ForegroundColor Red; exit 1 }
Write-Host "Created fresh database `"$dbName`"."

# ── 3 · migrate + seed ─────────────────────────────────────────────────────
& (Join-Path $PSScriptRoot 'migrate.ps1')
if ($LASTEXITCODE -ne 0) { Write-Host 'Migrations failed' -ForegroundColor Red; exit 1 }

& (Join-Path $PSScriptRoot 'seed.ps1')
if ($LASTEXITCODE -ne 0) { Write-Host 'Seed failed' -ForegroundColor Red; exit 1 }

# ── 4 · VERIFY the postcondition ───────────────────────────────────────────
$chk    = Invoke-Psql -Database $dbName -Quiet -Sql "SELECT count(*) FROM proc.purchase_requisitions;"
$prCount    = ($chk.out -replace '[^0-9]', '')
$vend       = Invoke-Psql -Database $dbName -Quiet -Sql "SELECT count(*) FROM core.vendors;"
$vendorCount = ($vend.out -replace '[^0-9]', '')

Write-Host ''
Write-Host ("Postcondition: {0} PR row(s), {1} vendor(s)." -f $prCount, $vendorCount) -ForegroundColor Cyan
if ([int]$prCount -ne 1 -or [int]$vendorCount -ne 6) {
  Write-Host 'RESET DID NOT PRODUCE A CLEAN SLATE — see the counts above.' -ForegroundColor Red
  exit 1
}
Write-Host "Reset complete: `"$dbName`" is fresh and seeded." -ForegroundColor Green
