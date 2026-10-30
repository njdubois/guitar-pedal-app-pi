# Pedal controller interface

A local browser interface for your Raspberry Pi 4, latching pedals, and KATANA:GO:2 or Katana MkII. It uses the existing GPIO, tone validator, amp driver, and looper controller. The launcher installs the Python requirements, including NumPy for track mixing. No npm installation is required to run the interface.

## 800 × 400 interface

Use Chromium in full screen or kiosk mode at 100% zoom so the browser content area has the full 800 × 400 pixels. Navigation stays visible; long lists and effect sections scroll inside their tab.

At startup choose the amplifier and press **Connect**. Automatic MIDI selection is the default; manual ports are under **MIDI connection settings**. A successful read opens the five tabs. The connection screen returns when the amp ports disappear or an amp operation reports a connection error. Port enumeration runs every three seconds without opening another amp session.

- **Amp**: open the **Amp**, **Equalizer**, or **Effects** card. Effects opens **Booster**, **MOD**, **FX**, **Delay**, and **Reverb** cards; each has its type selector and settings. Use Previous/Next within a section and the back button to return. The Delay card has Delay 1/Delay 2 buttons, and Pedal FX is available below the effect cards. Additional amp controls such as routing, solo, contour, noise suppression, Stage Feel, and USB audio follow the Amp card through Previous/Next navigation. Edit the mapped amp/effect controls, press **Apply changes**, and use **Save to library** to capture the current supported settings. **Read amp** refreshes settings after changes made on the amp or by pedals. Applying, reading, or capturing pauses physical pedal actions; restart them on the Pedals tab when ready.
- **Tones**: browse the library, load a tone into the amp, import/export JSON, or inspect and save a JSON copy. Loading a tone changes the live sound; assigning one from a pedal card only changes the pedal configuration.
- **Pedals**: view and edit the current pedal assignments, identify switches, save setup, and start/stop pedals. One pedal fills the tab. Use Previous and Next to move between pedals; edits stay in place as you navigate. Header pin and GPIO numbers are hidden.
- **Loops**: independent track recording/playback, selection, names, volume/mute, duplicate, clear and delete. Every track appears in the scrolling list.
- **Logs**: recent debug/activity messages, audio diagnostics, and a log download.

Section cards show the latest amp readings: amp model/variation, gain, tone volume and tone controls; EQ on/off, type and level; and each effect's on/off state, selected pedal and key settings. The Delay card shows both delay slots. Unapplied changes are labeled separately and do not replace the live summaries. Use **Read amp** to refresh after changing settings directly on the device.

The GO:2 guitar editor includes tone volume, all 23 boosters, all 28 MOD/FX algorithms and their controls, both EQs, noise suppression, routing/cabinet/key, solo EQ, contour, and pedal FX. Open a section card; longer settings scroll inside the card while its navigation and toolbar stay visible. Global EQ, Stage Feel and USB audio settings are amp-wide and are omitted from saved tones. New version 2 tone captures include all active tone controls. Original version 1 captures remain usable and leave newly mapped settings unchanged. Capturing or recalling a library tone does not write onboard preset memory. In Amp → Onboard memories, choose Bank 1–10 and A/B/C. Recall loads that saved tone; Write replaces that slot with the current applied live tone, including its live name. Apply pending edits first and pause pedal control while using this panel. Before writing, the controller saves the target's mapped settings and raw read replies in `.state/memory-backups/`, then verifies stored settings after the write. The backup is a diagnostic/recovery record, not a library-import file or an automatic full-memory restore. In Pedals, choose GO:2 channel and the bank/A/B/C to recall on a stomp. Pedals never write stored slots. See [protocol coverage and verification](docs/go2-protocol-notes.md).

## Start on the Pi

Copy the contents of `gpio-controller-ui-update.zip` into your existing `gpio-controller` folder. Replace the code files when asked. It updates the interface code, instructions, and tests. Your `pedals.json`, `tones/` folder, virtual environment, and saved state stay in place.

Stop the terminal controller with **Ctrl+C** before starting the interface. Both programs use the same GPIO inputs.

In a terminal inside your `gpio-controller` folder, run:

```sh
sh start-ui.sh
```

The launcher creates `.venv` if needed, installs the Python dependencies, and downloads a checksum-verified local Node.js 22 runtime if a suitable Node is unavailable. It creates a missing `pedals.json` with three unassigned GO:2 pedals, plus `tones/user/` and `.state/`. Existing configuration and tones are preserved. Subsequent launches reuse installed dependencies; internet access is needed for the first installation or dependency changes. On Raspberry Pi OS/Debian, missing system packages are installed through apt (sudo may ask for your password). Python 3.11 or newer is required. Run the script as your normal user. A browser opens on the Pi at **http://127.0.0.1:8080**. If it does not open automatically, enter that address in the Pi's browser. Leave the terminal running; **Ctrl+C** stops the app.

The interface starts with pedal actions stopped and loads your existing `pedals.json`. Its browser address is local to the Pi.

### Use a browser on your Mac

If you use SSH instead of a desktop on the Pi, open a Mac terminal and connect with port forwarding. Replace the username and hostname with the ones you normally use:

```sh
ssh -L 8080:127.0.0.1:8080 YOUR_PI_USER@YOUR_PI_HOST
```

In that SSH session, change to the Pi's `gpio-controller` folder and run `sh start-ui.sh --no-browser`. Then open **http://127.0.0.1:8080** in the Mac's browser. Keep the SSH session open. The interface and tone files still run on the Pi.

To troubleshoot pedal identification, open another SSH session on the Pi, change to this folder, and run `python3 diagnose_pedals.py`. Press each switch until it clicks, release it, and press it again. The monitor prints the BCM input and header pin for each change; two changes on one input confirm the UI is receiving that switch. It reads the running UI and does not claim GPIO pins. Stop it with Ctrl+C.

## Set up the pedalboard

1. Choose **Number of pedals**, from one to ten.
2. On the first card, click **Identify pedal**. Click the corresponding physical pedal twice: press until it clicks, release, then repeat. The card shows its detected connection.
3. Repeat for the other pedals. Identification pauses pedal actions. If the connection belongs to another card, the two connections swap; their tone assignments stay on their cards. Identification waits up to 25 seconds and can be cancelled.
4. Give each card a name and choose its action. Use **Load tone** to choose a JSON tone, **Looper** to choose a SooperLooper command, or **No action** to leave that pedal inactive.
5. Click **Save setup**. The app writes `pedals.json` and automatically backs up its previous contents.
6. Connect the amp on the startup screen before editing the pedalboard. A successful connection reads its current settings.
7. Click **Start pedals**. Physical clicks now recall the assigned tones or send the chosen looper commands.

**Test mode** logs what a pedal would do without sending amp or looper commands. **Stop pedals** stops further actions; an amp operation already in progress finishes before stopping. Editing an active setup also stops pedal actions, so click **Start pedals** again when ready.

The interface monitors the ten documented pedal inputs: BCM **17, 27, 22, 5, 6, 13, 19, 26, 23, 24**, plus any additional pins already present in the configuration when the app starts. Connect additional pedals to those documented inputs and use **Identify pedal**. The app does not discover pedals on arbitrary header pins.

## Import a downloaded tone JSON

The guitar tone app's `tone-plan.json` download works as-is. The supplied Green Day rhythm file contains an `explanation` and a `changes` object at the top level; it needs no wrapper, `profile` field, or conversion. Select **BOSS KATANA:GO:2** before importing this file, since a plain download does not declare its amp model.

To put this download on one of your physical pedals:

1. Make sure the pedal card is identified. Click **Identify pedal** and click the physical pedal twice if necessary.
2. On that card, click **Choose / import JSON**.
3. Click **Import JSON files** and select `tone-plan.json`. A single file imported from a card is automatically assigned to that card. To reuse a tone already in the library, click **Assign** next to it.
4. Choose **Same action on every click**, then click **Save setup**.
5. Tick **Test mode**, click **Start test**, and click the pedal. Check the **Logs** tab for its test action.
6. Click **Stop pedals**. Untick **Test mode**, click **Read amp** on the Amp tab, and wait for the successful connection message.
7. Click **Start pedals**. Each click now recalls the imported settings through USB MIDI.

The file picker opens on the computer running the browser: copy the download to the Pi when using the Pi's browser, or choose the Mac's local download when using its browser through SSH.

For a recognizable library name, optionally rename the download to `Green Day Rhythm.json` before importing. The original filename works too and appears as **tone plan**. The JSON's `explanation` is shown as a description; only the listed `changes` are sent to the amp. Keep the interface terminal open while using the pedals.

Other ways to add a tone:

On a pedal card, click **Choose / import JSON**. You can:

- Assign an existing library tone.
- Click **Import JSON files** and select a downloaded file with the mouse.
- Click **Paste JSON**, enter a tone name, and paste the complete JSON object.

The app validates the document against the selected amp model before saving it. Use Tone Lab's **Save plan** export or a tone captured by this controller. A GO:2 tone is rejected when the selected amp is a MkII, and vice versa. Generic BOSS backup/liveset files are not Tone Lab tone plans.

Imported files are saved in `tones/user/`. Names and amp profiles are saved in `.state/tone-library.json`. Importing a tone alone does not send it to the amp. After assigning it, save the setup and start the pedals.

**Tone library** also lets you inspect an existing JSON object and save an edited copy. **Refresh files** finds supported JSON files copied into the `tones` folder while the app is open.

## One action per click or separate A/B actions

**Same action on every click** matches the original controller: each click sends the same selected tone or looper command.

Choose **Different actions for A / B** to assign separate actions to the switch's two latched positions. The badge on the card shows the current position; click once to change it. Position **A** means the input contact is open; **B** means it is connected to ground. Neither label refers to holding your foot down. The initial position at startup does not send an action.

These assignments use optional `position_actions.open` and `position_actions.closed` arrays in `pedals.json`. The updated command-line controller also honors them for real GPIO inputs. Its command-line software simulator uses the default `actions` array; use the interface's demo mode to exercise both A/B states.

## Looper actions

The GO:2 built-in looper supports independent stereo tracks. Start pedals with a looper action assigned, or press **Start looper** on the Loops tab. The first recording sets the session's loop length. **Record new track** finishes any current take/overdub, creates and selects another track, and starts recording while the other tracks keep playing. Finish with **Record / replace**, **Finish recording**, or another **Record new track** stomp.

New takes repeat over whole multiples of the first loop's length. Finishing is immediate: a partial final cycle is padded with silence, keeping the recorded part aligned to the other tracks without delaying the stomp. There is no BPM detector or beat grid. Replacing the only recorded track can establish a new loop length; while other recordings remain, the session keeps its original cycle.

Looper operations, including physical pedal presses, automatically open the Loops tab. You can switch away afterward; playback alone does not keep pulling you back. The Loops tab lists every track, highlighting the selected one. Long lists scroll and follow track selection. Each row shows recording/playback/paused/empty state, duration, volume/mute, reverse, a position bar, and recorded input-level history. Click a track or use Previous/Next to select it. All tracks playing together share the sample clock. A paused individual track rejoins the current phase when resumed.

Every option below is available as a **Looper** pedal action:

| Action | Behavior |
| --- | --- |
| Add empty track | Create and select a separate empty track. |
| Record a new track | Create/select a separate track and record it alongside existing playback. |
| Record / replace selected track | Start a replacement take, or finish that track's recording. |
| Finish recording | Finish the active take or overdub and leave it playing. |
| Previous / Next track | Select tracks, wrapping at either end. |
| Rename selected track | Apply the name entered in that pedal's Track name field. |
| Duplicate selected track | Copy its audio/settings into a separately editable track and select the copy. |
| Delete selected track | Remove its audio and row. Deleting the last track leaves a new empty track. |
| Clear selected track | Erase audio while retaining that track's name and row. |
| Start / stop, Pause | Pause/resume the selected track without stopping the others. |
| Mute / unmute | Silence that track while preserving its timing. |
| Track volume +10% / −10% | Adjust only the selected track, within 0–100%. |
| Overdub, Undo, Redo | Layer onto the selected track, with its own undo/redo history. |
| Reverse, Play once, Restart | Affect only the selected track. |
| Play all / Stop all | Start or pause every recorded track. |
| Clear all | Erase all audio, retaining empty named track rows. |

For a basic three-pedal layout, assign **Record / replace selected track**, **Record a new track**, and **Scroll tracks (next, wraps to first)**. Each stomp selects the following track; after the last track it returns to the first. Choose other management commands as needed, or use the screen's Rename/Duplicate/Clear/Delete controls. Track selection affects subsequent pedal commands; **Finish recording** can finish a take even after navigating away from its track. Only one take/overdub records input at a time.

The session supports up to **16 tracks**, with **five minutes of stereo audio in total** (duplicates consume audio space too). Limits report a message without stopping existing playback. Mixing sums in 32-bit space and clips once at the output; lower individual track volumes if the mix clips. NumPy supplies the compiled mixer and is installed by the launcher.

Tracks remain in RAM when you stop/restart the looper or pedals, but are **not saved across an app/process restart**. Editing amp/pedal setup can stop audio, as before; press Start looper and Play all to resume retained tracks. Test mode logs pedal actions without touching amp/audio hardware; demo Loops controls can simulate recording and playback with silent input.

MkII/explicit OSC mode retains its original SooperLooper commands. Built-in track management commands are rejected in OSC configurations.

## Try the interface without hardware

```sh
sh start-ui.sh --demo
```

Demo mode provides **virtual pedal** buttons for identification and testing. It uses temporary copies of the config and tones, forces test mode, and never sends MIDI or looper commands. Demo changes disappear when the app exits.

Other launch options:

```sh
sh start-ui.sh --port 8081
sh start-ui.sh --no-browser
sh start-ui.sh --config /path/to/pedals.json
```

## Troubleshooting

- **Inputs unavailable:** stop any other pedal controller process, then click **Retry inputs**. Use the same Python environment that worked for the terminal controller.
- **Amp not found:** turn on the GO:2, use guitar mode, check the USB data cable, close BOSS Tone Studio, and use **Find MIDI ports** / **Read amp** on the Amp tab. Full errors appear in the **Logs** tab.
- **Tone rejected:** read the validation message. Confirm the selected amp and that the complete Tone Lab JSON object was imported.
- **Unsaved changes:** click **Save setup**. The app also saves changes before starting. Another browser window or an external file edit cannot silently overwrite the saved setup.
- **Port 8080 already in use:** stop another interface instance or start with `--port 8081`.

## Developer checks

The controller/interface checks use the installed Python requirements (including NumPy) and Node:

```sh
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
```

The audio tests cover independent PCM recording/mixing, cycle alignment, per-track edits and undo, navigation/deletion, resource limits, and pedal dispatch. The amp decoder tests replay recorded GO:2 MIDI frames without hardware. Browser interaction and 800 × 400 layout were also checked with Chromium; these unit tests do not replace checking physical GPIO/audio behavior on the Pi.

### Timing and playback feedback

Looper switches act on the first contact edge, with a quiet debounce interval afterward to suppress bounce; both latching directions count. Tone-only switches retain stable-state debounce. GPIO is sampled every 1 ms for the UI and for CLI configurations with loopers.

Audio uses direct ALSA I/O at the GO:2's native stereo 48 kHz / 16-bit format, requesting a 20 ms buffer. Processing follows the negotiated hardware period (normally 5 ms), and playback starts with three periods of silence queued to tolerate scheduling delays. A single full-volume track copies PCM without changing gain or format. Multiple tracks and track gain use the compiled NumPy mixer. The panel shows the actual playback buffer size and audio recovery count. These diagnostics do not measure total switch-to-speaker latency. Repeated recoveries indicate audio delivery interruptions.

The panel shows per-track state, recorded input-level history, and playback position. Input history is not a full saved waveform. Browser feedback refreshes every 250 ms and animates positions between updates. Pedal actions apply at the next audio block. Recording boundaries follow the existing loop cycle without BPM detection or a beat grid.
