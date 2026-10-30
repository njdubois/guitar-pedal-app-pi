#!/bin/sh
set -eu
task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_dir"

system_packages() {
    if ! command -v apt-get >/dev/null 2>&1; then
        echo 'Automatic system setup requires Raspberry Pi OS/Debian. Install Python 3 with venv, a C++ compiler, pkg-config and ALSA development headers (Linux), then retry.' >&2
        exit 1
    fi
    if [ "$(id -u)" = 0 ]; then
        apt-get update
        apt-get install -y python3 python3-venv python3-dev build-essential pkg-config libasound2-dev alsa-utils
    else
        echo 'Installing required system packages (sudo may ask for your password)...'
        sudo apt-get update
        sudo apt-get install -y python3 python3-venv python3-dev build-essential pkg-config libasound2-dev alsa-utils
    fi
}

if ! command -v python3 >/dev/null 2>&1; then system_packages; fi
if ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
    echo 'Creating the local Python environment...'
    if ! python3 -m venv .venv; then
        system_packages
        python3 -m venv .venv
    fi
fi
export PEDAL_PYTHON="$task_dir/.venv/bin/python"
export PATH="$task_dir/.venv/bin:$task_dir/.runtime/node/bin:$PATH"
if ! "$PEDAL_PYTHON" setup_ui.py "$@"; then
    echo 'Startup setup failed. See the error above; rerun sh start-ui.sh after resolving it.' >&2
    exit 1
fi
exec "$PEDAL_PYTHON" pedal_ui.py "$@"
