# Headless Raspberry Pi guitar pedal controller

This project turns a Raspberry Pi into an always-on controller for custom GPIO footswitches and BOSS Katana amplifiers. The Pi remains the USB host, so KATANA:GO:2 USB MIDI control and the multitrack USB-audio looper continue to work.

There is no desktop UI on the Pi. Two independent services start automatically whenever the Pi powers on:

| Service | Port | Responsibility |
| --- | ---: | --- |
| `guitar-pedal.service` | 8080 | GPIO pedals, Katana USB MIDI, USB audio, tones, looper, and JSON API |
| `guitar-pedal-web.service` | 4173 | Static browser frontend for Android, a phone, tablet, or computer |

The ESP32 target has been removed because the original ESP32 Audio Kit cannot continue the GO:2 looper over USB host.

## Recommended operating system

Use **DietPi 64-bit** for the lightest practical installation that remains compatible with this project. DietPi is minimal, Debian-based, uses `apt` and systemd, and supports Raspberry Pi hardware. For a Pi 4, choose the DietPi **Raspberry Pi 2/3/4/Zero 2 (ARMv8)** image. Pi 5 has its own DietPi image.

- [Download DietPi](https://dietpi.com/#download)
- [DietPi installation instructions](https://dietpi.com/docs/install/)
- [DietPi Raspberry Pi support](https://dietpi.com/docs/hardware/#raspberry-pi)

**[Raspberry Pi OS Lite 64-bit](https://www.raspberrypi.com/software/operating-systems/)** is the conservative alternative. It is larger, but has the highest level of official Raspberry Pi compatibility. Do not install a desktop environment on either OS.

The supplied installer supports Debian-based systems with `apt` and systemd. **Alpine Linux is not currently supported** because it uses `apk`, OpenRC, and musl; using Alpine would require different service definitions and a new native-dependency validation pass.

The current hardware target is a Raspberry Pi 4 running a 64-bit OS with Python 3.11 or newer. Other Pi models may work, but GPIO numbering, kernel drivers, and USB-audio behavior require validation on that model.

## Fresh installation or OS migration

Reinstalling an OS erases the target card. Use a new microSD card when possible so the old installation remains a working rollback.

Before replacing an existing installation, back up:

- `pedals.json` — active pedal and amp configuration;
- `tones/` — bundled, imported, and captured tones;
- `.state/` — configuration, tone, and amp-memory backups;
- any additional `pedals.*.json` configurations you use.

Looper audio lives only in RAM and cannot be migrated across a reboot or OS replacement.

### 1. Prepare the Pi

Flash the appropriate DietPi 64-bit image, complete its first-boot update, configure Wi-Fi, and enable SSH. Copy or clone this repository to a persistent location owned by the account that will run the controller, such as:

```text
/home/dietpi/guitar-pedal-app-pi
```

Restore `pedals.json`, `tones/`, and `.state/` into that repository before installing the services.

### 2. Install both boot services

From the repository directory, run:

```sh
sudo sh install-pi-service.sh --user dietpi
```

For Raspberry Pi OS, replace `dietpi` with the normal account name if necessary. To use a different network name:

```sh
sudo sh install-pi-service.sh --user dietpi --hostname stage-pedal
```

The default hostname is `guitar-pedal`. The installer:

- installs Python, ALSA, compiler, and mDNS packages;
- creates `.venv` and installs the Python requirements;
- uses a suitable system Node.js or downloads a checksum-verified local Node 22 runtime;
- adds the service account to the available `audio` and `gpio` groups;
- installs, enables, and starts both systemd services;
- enables Avahi so the `.local` hostname is advertised.

Internet access is required for the first installation. Existing configurations, tones, and state are not overwritten.

### 3. Reboot and verify automatic startup

```sh
sudo reboot
```

After reconnecting over SSH, verify both services:

```sh
systemctl is-enabled guitar-pedal guitar-pedal-web
systemctl status guitar-pedal guitar-pedal-web
```

Both services should report `enabled` and `active (running)`. Follow their combined logs with:

```sh
journalctl -u guitar-pedal -u guitar-pedal-web -f
```

Useful service commands:

```sh
sudo systemctl restart guitar-pedal guitar-pedal-web
sudo systemctl stop guitar-pedal guitar-pedal-web
sudo systemctl start guitar-pedal guitar-pedal-web
```

After pulling a future project update, rerun `sudo sh install-pi-service.sh --user dietpi`. It refreshes dependencies and service definitions, then restarts both services without replacing `pedals.json` or your tones.

## Open the controller on Android

No terminal or separately installed Android application is needed.

1. Connect Android to the same trusted Wi-Fi/LAN as the Pi.
2. Open Chrome.
3. Visit **http://guitar-pedal.local:4173**.
4. Optionally choose **Chrome menu → Add to Home screen**.

If `.local` does not resolve, find the Pi's address with `hostname -I` over SSH or in the router, then open:

```text
http://PI_LAN_IP:4173
```

The frontend automatically derives its API address from the hostname or IP used to open it, changing only the port from 4173 to 8080. The **Pi server** field in the header can override that address and remembers the choice for that particular frontend hostname.

Production use does not require `npm run web`; `guitar-pedal-web.service` hosts the frontend automatically.

## Startup behavior

At boot, the API service:

1. loads and validates `pedals.json` and referenced tones;
2. starts the GPIO monitor;
3. waits for the configured hardware to become available;
4. automatically starts pedal actions;
5. retries if required GO:2 USB audio is not connected yet.

The frontend service starts independently. It can display the controller page even while the API is waiting for GPIO, MIDI, or audio hardware. Editing the setup, identifying a pedal, or using certain amp operations can intentionally pause pedal actions; the browser provides the controls to start them again.

## Katana USB and GPIO requirements

The Pi must be the USB host. Connect a Pi USB port to the GO:2 USB-C port or Katana MkII USB-B port with a data-capable cable. Do not use a charge-only cable. Keep the GO:2 in guitar mode, and close BOSS Tone Studio or other software that may claim the same MIDI port.

The supported amp profiles are **KATANA:GO:2** and **Katana MkII**. The original KATANA:GO, original Katana, and Katana Gen 3 are not supported by the current protocol maps.

The GPIO inputs use 3.3 V logic and are not 5 V tolerant. Footswitch contacts must never carry amp, guitar-audio, 5 V, or 3.3 V wiring. Detailed GPIO wiring, pedal identification, amp-editor, tone-library, MIDI-port, and looper instructions are in [README_UI.md](README_UI.md).

## USB looper

The built-in looper uses the Katana as a USB audio interface and provides:

- 48 kHz, 16-bit stereo audio;
- up to 16 tracks;
- up to five minutes of stereo audio across the whole session;
- record, overdub, finish, undo/redo, mute, pause, reverse, one-shot, and trigger;
- track selection, rename, duplicate, delete, clear, and per-track volume;
- play-all and stop-all controls;
- browser controls and pedal-triggered actions from `pedals.json`.

Loop audio is held in RAM. It is cleared when the controller service or Pi restarts.

## Network and security boundary

The controller is intended for a trusted local network:

- frontend: `http://guitar-pedal.local:4173`;
- API: `http://guitar-pedal.local:8080`;
- command token: randomly regenerated whenever the API service starts;
- transport: unencrypted HTTP on the local network.

Do not forward ports 4173 or 8080 through the router. For access away from home, use a trusted VPN such as WireGuard or Tailscale rather than exposing the controller directly to the internet.

Guest Wi-Fi and client-isolation settings can prevent Android from reaching the Pi even when both devices appear connected to the same network.

## Troubleshooting

### Android cannot open the frontend

1. Confirm Android and the Pi are on the same non-guest network.
2. Try `http://PI_LAN_IP:4173` instead of the `.local` name.
3. Check the frontend service:

   ```sh
   systemctl status guitar-pedal-web
   journalctl -u guitar-pedal-web -n 100 --no-pager
   ```

### The page opens but cannot reach the controller

Check the API service and the **Pi server** address shown in the page header:

```sh
systemctl status guitar-pedal
journalctl -u guitar-pedal -n 100 --no-pager
curl http://127.0.0.1:8080/api/state
```

### Pedals never become ready

Only one process can own the GPIO inputs. Stop manually launched copies of `pedal_controller.py`, `pedal_ui.py`, or `start-ui.sh`, then restart the production service:

```sh
sudo systemctl restart guitar-pedal
```

Check that the service account belongs to the available GPIO group and inspect the service log for the exact pin error.

### The GO:2 or Katana is not found

- confirm the amp is powered on and the USB cable carries data;
- close BOSS Tone Studio and other MIDI applications;
- keep the GO:2 in guitar mode;
- inspect MIDI and audio enumeration:

  ```sh
  aconnect -l
  aplay -l
  arecord -l
  ```

- restart `guitar-pedal` after reconnecting the amp.

### `.local` does not resolve

Confirm Avahi is running:

```sh
systemctl status avahi-daemon
hostname -I
```

Using the displayed LAN IP is always an acceptable fallback.

## Development and hardware-free demo

Production uses the two systemd services. The commands below are for development only.

Start a hardware-free API demo in one terminal:

```sh
sh start-ui.sh --demo --no-browser --bind 127.0.0.1 --cors-origin http://127.0.0.1:4173
```

Start the independent frontend in another terminal:

```sh
./start-web.sh
```

Open `http://127.0.0.1:4173`. Demo mode uses temporary copies of the configuration and tones, exposes virtual pedal buttons, forces safe test behavior, and sends no MIDI or looper commands.

Run the JavaScript tests:

```sh
npm test
```

Run the Python tests after dependencies are installed:

```sh
.venv/bin/python -m unittest discover -s tests
```

Hardware timing, GPIO pull-ups, USB permissions, amp enumeration, and end-to-end audio still require validation on the physical Pi.

## Project map

| Path | Purpose |
| --- | --- |
| `install-pi-service.sh` | Installs dependencies and both boot-enabled systemd services |
| `start-server.sh` | Starts the production GPIO/MIDI/audio/API process |
| `start-web.sh` | Starts the production frontend process |
| `pedal_ui.py` | Headless application state and HTTP API |
| `pedal_controller.py` | GPIO sampling, action dispatch, tone worker, and OSC support |
| `audio_looper.py` | USB-audio multitrack looper |
| `web/serve.mjs` | Static frontend server and runtime API-address configuration |
| `ui/` | Browser application |
| `pedals.json` | Active pedal and amp configuration |
| `tones/` | Bundled and user tone files |
| `tests/` | Hardware-free Python and JavaScript checks |

See [README_UI.md](README_UI.md) for detailed operating instructions after installation.
