#!/usr/bin/env bash
# Runs `mcpc events-hook <session-start|stop>` with the hook JSON on stdin.
# MCPC_BIN overrides which mcpc is used (e.g. "node /path/to/mcpc/dist/cli/index.js").
set -euo pipefail
if [[ -n "${MCPC_BIN:-}" ]]; then
  # shellcheck disable=SC2086
  exec $MCPC_BIN events-hook "$1"
fi
if ! command -v mcpc >/dev/null 2>&1; then
  echo "mcpc-events plugin: mcpc is not on PATH; install it or set MCPC_BIN" >&2
  exit 1
fi
exec mcpc events-hook "$1"
