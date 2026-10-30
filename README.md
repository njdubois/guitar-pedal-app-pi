# Connect one pedal first


For the browser UI, run **`sh start-ui.sh`**. It installs dependencies and creates missing setup files automatically; see [UI startup instructions](README_UI.md). The manual installation below is also available for the command-line controller.
[Print the wiring specification (one-page PDF)](../raspberry_pi_katana_wiring.pdf). It includes the complete 40-pin GPIO header, board orientation, switch terminal view, and connections for three pedals. **Physical header pin 11 is BCM GPIO17.**

![Monochrome wiring specification: GPIO header, switch terminals, and three-pedal connection table](../raspberry_pi_katana_wiring.svg)

This first test uses **one switch**, one 1 kΩ resistor and two wires. Leave the Katana disconnected for now.

1. Unplug the Pi. Look at the switch from the solder-terminal side. The center terminal is **C** (common). Using a multimeter's continuity mode, find an adjacent terminal **T** for which C-T alternates between continuity and open each time you click the switch. Rotate the switch so C and T match the diagram before wiring.
2. Wire **C** through a **1 kΩ resistor** to Pi **J8 physical pin 11 (GPIO17)**.
3. Connect **T** to Pi **J8 physical pin 6 (GND)**.
4. Leave the other **seven solder terminals** unconnected. Insulate bare terminals so they cannot touch.

Pi GPIO uses 3.3 V and is **not 5 V tolerant**. Connect no 5 V, 3.3 V, amp, or guitar wire to the switch. The script enables the input pull-up, so you do not need to connect a supply pin. [See the Raspberry Pi GPIO guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#gpio-pinout).

The controller responds to each stable switch change in either direction. Since the switch latches, each click creates one change and one action.

## Add more switches

Repeat the same wiring for each extra pedal: its own resistor and its own GPIO pin. Connect all switches' ground wires to Pi **J8 pin 6** (a breadboard ground rail can join them).

| Switch | Pi J8 physical pin | BCM GPIO | Default action |
| --- | ---: | ---: | --- |
| 1 | 11 | 17 | Clean tone |
| 2 | 13 | 27 | Drive tone |
| 3 | 15 | 22 | Looper record |
| Every switch's GND contact | 6 | GND | Shared ground |

Connect an individual switch's signal to only one GPIO. Never connect two signals together. The [ten-switch configuration](pedals.ten-switches.json) lists pins for a larger setup.

## What this sample controls

The Raspberry Pi reads the switches, loads a tone JSON file from its SD card, and sends its settings over USB MIDI to a KATANA:GO:2 in guitar mode or a Katana MkII. Looper switches send commands to SooperLooper. Audio is routed separately; the GPIO wires do not carry audio. The Pi does not need an AI connection when recalling a tone already saved locally.

The amp loader uses the Tone Lab validator and protocol drivers with locally extended GO:2 guitar controls, including tone volume, complete MOD/FX settings, both EQs, noise suppression, routing and solo controls. See [the touchscreen UI](README_UI.md) and [GO:2 protocol coverage](docs/go2-protocol-notes.md). The controller also checks amp identity, saves the old supported settings before a tone change, and reads settings back after the change. Its profile checks reject GO:2 tones on a MkII and vice versa.

The sample does not support a Katana Gen 3, the original KATANA:GO, or the original Katana. You can use the latching switch GPIO and looper parts independently of the amp loader.

## Set up the Pi

Use current Raspberry Pi OS and a USB data cable. The **Pi is the USB host**; connect Pi USB to the GO:2's USB-C port or the MkII USB-B port. Do not try to power the amp or Pi from a GPIO pin. Keep the GO:2 in guitar mode and close BOSS Tone Studio or another amp editor before recalling tones.

This integration targets Linux on the Pi 4, a Pi 4-compatible `lgpio` GPIO Zero pin factory, Node.js 22.12+, and Python 3. Install system requirements:

```sh
sudo apt update
sudo apt install -y python3-venv python3-dev python3-gpiozero python3-lgpio libasound2-dev build-essential pkg-config alsa-utils
```

Install the current [Node.js 22 LTS release for Linux](https://nodejs.org/en/download/) for the Pi's processor architecture, then verify `node --version` reports at least **22.12**. The existing AI web application uses ES modules; the local player uses those same ES modules and requires Node 22.12. No npm packages are needed.

In Terminal, copy the project folder to the Pi and run:

```sh
cd /path/to/guitar-pedal-switch-enclosure/gpio-controller
python3 -m venv --system-site-packages .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
```

If `/dev/snd/seq` or GPIO access is denied, check which groups own the devices (`ls -l /dev/snd/seq /dev/gpiomem`). Add your normal login to the displayed groups if required, then log out and back in. For this Pi 4 sample, explicitly select the GPIO Zero `lgpio` backend when launching:

```sh
GPIOZERO_PIN_FACTORY=lgpio python pedal_controller.py --dry-run
```

`--dry-run` validates all local tone files, logs simulated GPIO events, and sends **no** MIDI or looper commands. Initially, use the interactive software switch simulator:

```sh
python pedal_controller.py --simulate --dry-run
```

Type `1`, `2` or `3`, then Enter; type `q` to exit. `--stomp 1 --dry-run` checks one switch without opening GPIO. This safe run needs no Pi GPIO, Katana or SooperLooper connection, but does require Node 22.12+ and the Python dependencies above.

## Connect a Katana and use switch tones

Start with the GO:2 config and preview its detected USB MIDI ports:

```sh
GPIOZERO_PIN_FACTORY=lgpio python pedal_controller.py --config pedals.json --dry-run
node katana_tones.mjs ports
```

`node katana_tones.mjs ports` needs the Mido/RtMidi packages but sends no MIDI. Connect and turn on one amp, then list ports again. If multiple Katana MIDI ports exist, copy their exact names to `amp.input` and `amp.output` in the config. If the names contain DAW and ordinary USB/MIDI endpoints, choose the ordinary MIDI pair, not DAW CTRL. Use the profile and port selection for the currently connected amp. Check the separate command-line MIDI view with `aconnect -l` if a powered GO:2 or MkII does not appear. A USB data cable, normal Linux ALSA MIDI permissions, guitar mode on the GO:2, and closed BOSS software are required. No GPIO actions write anything until an amp passes the Tone Lab device-identity check.

The example tone files contain complete starter plans with every supported effect enabled/disabled explicitly. Both are mild basic presets: **Clean** uses the clean amp character and gain 25; **Drive** uses crunch and gain 55. For either profile:

```sh
node katana_tones.mjs validate --profile go2 --file tones/go2/clean.json
node katana_tones.mjs read --profile go2
node katana_tones.mjs apply --profile go2 --file tones/go2/clean.json
```

Change `go2` to `mkii` and use files under `tones/mkii/` for the MkII. A GO:2 JSON plan cannot be recalled on the MkII; the profile and settings are different and the loader rejects a mismatch before opening USB MIDI. Read tests current amp settings. `apply` validates the plan, confirms amp identity and guitar mode, checks supported values and the effect's current type, saves the mapped pre-change tone to `.state/history/`, applies the temporary tone, and reads changes back from the amp. A successful result has `"verified": true`. A failed write saves a failed-operation record; read the amp before trying again.

To capture a complete tone from the connected amp to a new local file first:

```sh
node katana_tones.mjs capture --profile go2 --out tones/go2/my-tone.json
node katana_tones.mjs validate --profile go2 --file tones/go2/my-tone.json
```

Then assign the new file to a switch in `pedals.json`. Capture refuses to overwrite an existing file. Tone Lab's **Save plan** download also works directly: copy its `tone-plan.json` to this Pi and point that switch at the path. The phone/browsed copy and the Pi do not sync automatically; copy the downloaded JSON file over. Generic saved plans may change only the fields listed in `changes`; parameters left out keep their current amp values. If every recall must establish a fully defined sound, use a file captured by the `capture` command. A full snapshot restores the current supported editable controls, but does not change amp channels or write to the Katana's onboard presets.

Tone plans that contain a `restore` record, a device memory backup, a mismatched profile or unsupported controls are rejected. Amp presets recalled by switches are **temporary current-tone edits**. The controller does not call the app's persistent preset writer and does not save into the amplifier's onboard memories.

By default, switch hits are **not** delayed or replayed after a disconnect. One amp write runs at a time, with at most the newest waiting tone kept for three seconds. A busy controller reports which tone it recalls; a slow/disconnected device reports an error; step on the desired switch again after fixing it. Looper OSC sends are separate and do not wait for USB/MIDI operations.

## Hook up SooperLooper

GO:2 looper actions now start a built-in stereo audio looper automatically. The GO:2 is both the USB capture and playback interface, using its native 48 kHz, 16-bit stereo format. No additional audio interface or SooperLooper service is needed. The looper uses the system ALSA `libasound` library directly, with processing aligned to the hardware period and a requested 20 ms buffer. Record starts/replaces the selected track; the next record finishes it. Record new track creates a separate synchronized recording while existing tracks keep playing. Track selection, rename, duplicate, delete, clear, per-track volume/mute, and all-track transport are available in the UI and as pedal actions. NumPy supplies compiled multi-track mixing. Only recorded audio returns over USB; live monitoring stays on the GO:2. Up to 16 tracks are held in memory, with five minutes of stereo audio total; tracks do not persist across process restarts. See [looper controls](README_UI.md#looper-actions).

To keep using a separately managed SooperLooper, set `looper.engine` to `"osc"`; MkII defaults to this mode. OSC commands go to the configured host/port using `/sl/<loop>/hit`. Built-in track management and the `play_stop` and `clear` actions are not available in OSC mode.

The three-switch config includes clean, drive and record. The separate [ten-switch config](pedals.ten-switches.json) adds overdub, undo, redo, mute, pause, reverse, and one-shot. All switches use BCM GPIO numbering and the same common-ground scheme. To route button events to a custom looper, replace a command with an event:

```json
{ "type": "event", "name": "my-looper.toggle-record" }
```

The script prints each such event as one newline-delimited JSON object; another local service can subscribe through standard input/output or a pipe.

## Adjust the switch map

Edit `pedals.json`. A switch `id` is used only for simulator commands; `gpio` is a BCM number, and `actions` can include one or more tone, looper or event commands. The script arms the current switch state without triggering it at startup. Tone-only switches wait for 30 ms of settled contact by default. Looper switches trigger on the first edge and suppress further edges until the contact settles. The CLI polls every 1 ms when loopers are assigned, otherwise every 5 ms; the UI polls every 1 ms. You can tune `debounce_ms` from 5–250 ms and `poll_ms` from 1–20 ms for your switch. The 3PDT contact latches each time it is pressed, so the script treats **both** high→low and low→high stable transitions as stomps; it never interprets release as an additional stomp.

On the Pi, start the controller with the configuration and direct GPIO backend:

```sh
GPIOZERO_PIN_FACTORY=lgpio python pedal_controller.py
```

Press **Ctrl+C** to stop it. The default `pedals.json` uses a GO:2. To select the MkII config, run `GPIOZERO_PIN_FACTORY=lgpio python pedal_controller.py --config pedals.mkii.json`. `pedals.ten-switches.json` is a ten-switch GO:2 example; change its profile and tone files if using the MkII.

## Code and checks

| File | Purpose |
| --- | --- |
| `../raspberry_pi_katana_wiring.pdf`, `../raspberry_pi_katana_wiring.svg` | Monochrome wiring specification with all 40 header pins, board orientation, switch terminal view, and three-pedal connection table. |
| `pedal_controller.py` | GPIO sampler, stable transition/debounce, looper/event routing, tone-job queue and simulator. |
| `katana_tones.mjs` | Local Tone Lab JSON validator, capture, read, and verified tone recall. |
| `linux_midi.mjs`, `midi_bridge.py` | Mido/RtMidi transport. No hidden amp map; profile maps/identity checks are the copied Tone Lab modules. |
| `pedals.json`, `pedals.mkii.json` | Three-switch GO:2 and MkII examples. |
| `pedals.ten-switches.json` | Ten-switch GO:2 expansion example. |
| `tones/` | Local example plans for the two supported amp profiles. |
| `vendor/tone-lab/manifest.json` | Module source and SHA-256 fingerprints. |

Run the hardware-free config, debounce, OSC-packet and Tone Lab profile checks with Node and Python:

```sh
cd gpio-controller
node --test tests/*.test.mjs
python -m unittest discover -s tests -v
python -m py_compile pedal_controller.py midi_bridge.py
```

Also run a real connected-amp read before connecting the stomp GPIOs, and use `--dry-run` to confirm the chosen pins. Pi 4 USB MIDI visibility, the particular Linux ALSA setup, switch lug orientation, overall 3PDT terminal continuity and SooperLooper audio routing depend on the user's hardware and require a practical setup check. If the GO:2 will not appear as a MIDI endpoint, run the safe `node katana_tones.mjs ports`, `aconnect -l`, check cable and USB data mode, and let me inspect your output before altering the MIDI or amplifier protocol. [Mido's RtMidi backend documentation](https://mido.readthedocs.io/en/stable/backends/rtmidi.html) explains the Linux/ALSA ports used by this bridge.
