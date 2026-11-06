#!/bin/sh
set -eu
task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_dir"

export PATH="$task_dir/.runtime/node/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
    echo 'Node.js is missing. Run: sudo sh install-pi-service.sh' >&2
    exit 1
fi

export PORT="${PEDAL_WEB_PORT:-4173}"
export PEDAL_API_PORT="${PEDAL_API_PORT:-8080}"
export PEDAL_API_SAME_HOST="${PEDAL_API_SAME_HOST:-1}"

exec node web/serve.mjs
