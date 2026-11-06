#!/bin/sh
set -eu

task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_name=guitar-pedal
web_service_name=guitar-pedal-web
pi_hostname=guitar-pedal
service_user=${SUDO_USER:-$(id -un)}

usage() {
    echo "Usage: sudo sh install-pi-service.sh [--hostname NAME] [--user USER]"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --hostname) pi_hostname=${2:?Missing hostname}; shift 2 ;;
        --user) service_user=${2:?Missing user}; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done

case "$pi_hostname" in
    *[!A-Za-z0-9-]*|''|-*|*-) echo 'Hostname may contain letters, numbers, and internal hyphens only.' >&2; exit 2 ;;
esac
if ! id "$service_user" >/dev/null 2>&1; then
    echo "User does not exist: $service_user" >&2
    exit 2
fi
if [ "$(id -u)" != 0 ] && [ "$service_user" != "$(id -un)" ]; then
    echo 'Run this installer through sudo when selecting a different service user.' >&2
    exit 2
fi
if ! command -v apt-get >/dev/null 2>&1; then
    echo 'This installer requires Raspberry Pi OS or another Debian-based OS.' >&2
    exit 1
fi

if [ "$(id -u)" = 0 ]; then
    sudo_cmd=''
else
    sudo_cmd=sudo
fi

$sudo_cmd apt-get update
$sudo_cmd apt-get install -y python3 python3-venv python3-dev build-essential pkg-config libasound2-dev alsa-utils avahi-daemon

if [ "$(id -u)" = 0 ] && [ "$service_user" != root ]; then
    run_as_user="runuser -u $service_user --"
else
    run_as_user=''
fi

if [ ! -x "$task_dir/.venv/bin/python" ]; then
    $run_as_user python3 -m venv "$task_dir/.venv"
fi
$run_as_user env PEDAL_PYTHON="$task_dir/.venv/bin/python" PATH="$task_dir/.venv/bin:$task_dir/.runtime/node/bin:$PATH" \
    "$task_dir/.venv/bin/python" "$task_dir/setup_ui.py"

for group in audio gpio; do
    if getent group "$group" >/dev/null; then
        $sudo_cmd usermod -aG "$group" "$service_user"
    fi
done

$sudo_cmd hostnamectl set-hostname "$pi_hostname"
$sudo_cmd systemctl enable --now avahi-daemon
unit_file=/etc/systemd/system/$service_name.service
web_unit_file=/etc/systemd/system/$web_service_name.service
temporary_unit=$(mktemp)
temporary_web_unit=$(mktemp)
trap 'rm -f "$temporary_unit" "$temporary_web_unit"' EXIT HUP INT TERM
sed -e "s|@USER@|$service_user|g" -e "s|@ROOT@|$task_dir|g" >"$temporary_unit" <<'EOF'
[Unit]
Description=Headless guitar pedal controller
Wants=network-online.target sound.target
After=network-online.target sound.target

[Service]
Type=simple
User=@USER@
WorkingDirectory="@ROOT@"
ExecStart=/bin/sh "@ROOT@/start-server.sh"
Restart=on-failure
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
sed -e "s|@USER@|$service_user|g" -e "s|@ROOT@|$task_dir|g" >"$temporary_web_unit" <<'EOF'
[Unit]
Description=Guitar pedal browser frontend
Wants=network-online.target guitar-pedal.service
After=network-online.target guitar-pedal.service

[Service]
Type=simple
User=@USER@
WorkingDirectory="@ROOT@"
ExecStart=/bin/sh "@ROOT@/start-web.sh"
Restart=on-failure
RestartSec=3
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF
$sudo_cmd install -m 0644 "$temporary_unit" "$unit_file"
$sudo_cmd install -m 0644 "$temporary_web_unit" "$web_unit_file"
$sudo_cmd systemctl daemon-reload
$sudo_cmd systemctl enable "$service_name.service" "$web_service_name.service"
$sudo_cmd systemctl restart "$service_name.service" "$web_service_name.service"

echo
echo "Installed and started $service_name.service and $web_service_name.service."
echo "Pi API:       http://$pi_hostname.local:8080"
echo "Android UI:   http://$pi_hostname.local:4173"
echo "Service logs: journalctl -u $service_name -u $web_service_name -f"
