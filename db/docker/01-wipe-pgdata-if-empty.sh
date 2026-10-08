#!/bin/bash
# One-time wipe on FIRST boot only (when pgdata is empty).
# On subsequent restarts, this script runs again but finds a populated pgdata
# and exits without destroying data. Replaces the old `command: rm -rf ...`
# workaround that wiped the DB on every container restart.
set -e
if [ -z "$(ls -A /var/lib/postgresql/data/pgdata 2>/dev/null)" ]; then
  echo "[init] pgdata empty, will let postgres initdb"
else
  echo "[init] pgdata populated, preserving"
fi
exit 0