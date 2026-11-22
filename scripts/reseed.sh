#!/usr/bin/env bash
# The ledger is append-only by design, so "resetting" means starting a new database.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .pgdata attestations out/last_run.json
node scripts/migrate.mjs
node scripts/run_scenarios.mjs
