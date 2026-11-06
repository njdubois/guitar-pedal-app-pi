#!/bin/sh
set -eu
task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_dir"

if [ ! -x .venv/bin/python ]; then
    echo 'The pedal environment is missing. Run: sudo sh install-pi-service.sh' >&2
    exit 1
fi

export PEDAL_PYTHON="$task_dir/.venv/bin/python"
export PATH="$task_dir/.venv/bin:$task_dir/.runtime/node/bin:$PATH"
export GPIOZERO_PIN_FACTORY="${GPIOZERO_PIN_FACTORY:-lgpio}"

exec "$PEDAL_PYTHON" -u pedal_ui.py \
    --bind "${PEDAL_BIND:-0.0.0.0}" \
    --port "${PEDAL_PORT:-8080}" \
    --cors-origin "${PEDAL_CORS_ORIGIN:-*}" \
    --no-browser \
    --auto-start \
    "$@"
