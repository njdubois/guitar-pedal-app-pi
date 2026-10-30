# KATANA:GO:2 guitar editor protocol

The Linux UI edits temporary guitar-tone settings over USB MIDI. No Windows,
macOS, mobile app, AI service, or firmware change is required. MkII remains a
separate profile. The guitar-mode guard runs before reads and writes.

## Coverage

The GO profile exposes 564 controls, counting both MOD/FX slots and each stored
algorithm's controls. The UI shows the selected algorithm's controls. It reads
inactive algorithms too, so changing effects starts with that algorithm's stored
values, rather than replacing them with invented minima.

- Amp: five models plus variation, gain, tone volume, bass/middle/treble/presence.
- Booster: all 23 guitar types, drive, bottom, tone, solo switch/level, effect
  level and direct mix.
- MOD and FX: all 28 guitar algorithms and their individual controls, including
  subtype selectors, crossovers, filters, EQ frequency/Q, two pitch/harmony
  voices, and both 12-note user scales.
- Both delays: all eight types, timing, feedback, cuts, mixes, tap time,
  modulation, SDE filter and phase settings.
- Reverb: all five types, time/pre-delay, cuts, density, level/direct mix, color.
- Solo: enable/level and its complete three-band parametric EQ.
- Contour: three configurable contour slots, four shapes per slot, shifts.
- Pedal FX: input/post-amp position, enable, Wah, Wah 95E and Pedal Bend controls.
- EQ 1 and EQ 2: enable, position, parametric/GE-10 selection and all controls.
- Noise suppressor: enable, threshold, release.
- Routing, cabinet resonance, master musical key.
- Amp-wide controls: global parametric EQ, Stage Feel/custom positions and
  ambience, USB input/output level and loopback.

This covers the guitar tone-creation sections in the BOSS parameter guide. Bass
mode, tuner display, Bluetooth controller
assignments, and the BOSS app's Session/Tone Exchange services are separate
features, not implemented by this editor. Unsupported bass-only/internal bytes
are never exposed as guitar controls.

## Sources and disagreements

Protocol facts were independently expressed in this project, cross-checked with:

- [BOSS GO parameter guide](https://static.roland.com/assets/media/pdf/KATANA_GO_parameter_eng02_W.pdf): guitar control names, ranges and available effects.
- [Powerlated's Linux Tone Studio port](https://github.com/Powerlated/BOSS-TONE-STUDIO-for-Linux): useful Linux MIDI/WebView integration, but its supported editor is Katana Gen 3, whose addresses are not interchangeable with GO.
- [Pyrrhu5's GO protocol map](https://github.com/Pyrrhu5/boss-katana-go/blob/main/katana_go/resources/roland_sysex.yaml): independently corroborates the amp/volume addresses.
- [KatanaSwift GO addresses](https://github.com/Henryforce/KatanaSwift/blob/main/SupportingFiles/KATANA_MIDI_ADDRESSES.md) and its GO data banks.
- [GO FxFloorBoard source, Qt6.9 release](https://sourceforge.net/projects/fxfloorboard/files/KatanaFxFloorBoard/Katana%20FxFloorBoard%20for%20GO%20Desktop/): cross-check of GO addresses, enumerations, and fractional EQ encoding.
- [GO patch-format research](https://github.com/cordfuse/toneai-katana-web/blob/main/docs/go-format-notes.md): independent amp offsets and ranges derived from the GO app.

References contain discrepancies. The editor uses EQ enable at offset 0,
position at offset 1; master key at `20 00 10 02`; Pedal Bend=1, Wah95=2;
solo EQ and GE-10 use half-dB steps with raw 24 = 0 dB. Guitar Sim body/level
and T-Wah/Auto-Wah level/direct addresses were corrected. Foot volume at
`20 02 40 03` is not readable on the connected device and is not fabricated as
a supported tone knob. Stage Feel ambience is narrow/wide (not three room types),
and its position values are angles in three-degree steps. The actual pedal FX selector block is three bytes.

## Snapshots and compatibility

Version 2 captures include all active guitar tone settings, including volume,
EQ and noise suppression. System controls are edited separately and omitted
from tone capture/recall. Apply history also records previous system settings
in a separate `systemSettings` object. Original version 1 snapshots still
validate against their original mapped fields; missing newly mapped fields are
left unchanged when recalled. No default volume is inserted into old tones.

Each normal Apply validates, captures the prior settings, writes the requested
values and compares a fresh readback. On type changes it verifies requested
controls and unchanged controls outside the changed block. A hardware error
returns to the connection screen. Pedal tone recall returns the fresh settings
to the browser without opening a competing MIDI session.

## Hardware evidence

Evidence stays locally in `.state/protocol-verification/`. The initial tone
volume test read 22, wrote/read 21, and restored/read 22. The full integration
check holds tone volume at zero, exercises mapped values/selectors, restores
all mapped original values, then compares all stored settings. On this connected GO:2, the full sweep plus the corrected system follow-up verified 564 distinct controls across 1,551 write/readback checks; both runs restored their original values. The browser integration also applied volume and an effect-type change, captured/exported the result, and recalled the original tone. A final read compared all 564 stored values with the original backup. Run it only
when deliberately testing the connected amp:

```sh
PEDAL_PYTHON="$PWD/.venv/bin/python" node tools/verify_go_controls.mjs --write-and-restore
```

`tests/fixtures/go2-wire.json` contains real USB read frames for offline decoder
regression tests. GO reads are split into at most 64-byte requests; oversized
requests and reads extending past a bank can leave the amp silent.

## GO:2 bank and channel memories

Ten guitar banks contain A/B/C, with zero-based slot `(bank - 1) * 3 + channelIndex`.
The explicit memory panel and pedal recall use GO-specific commands described by
[GO FxFloorBoard](https://sourceforge.net/projects/katana-go-fxfloorboard/):
DT1 `7F 00 01 00` with `00 slot` recalls; DT1 `7F 00 01 04` with `00 slot` stores the live tone.
RQ1 `7F 00 01 00`, size 2, returns the selected slot after editor negotiation.
The older editor's `00 01 00 00` query did not answer on this GO:2 and is not used.

For stored tone reads, the live page `20 page bank offset` maps to the base-128
address with page `(slot + 1) * 16 + page`. Live/system queries stay unchanged.
On the connected GO:2, all 30 slot names, current slot 1A and the 564 mapped
settings in stored 1A were read successfully. Persistent writes and channel
recall commands were exercised with a mock transport; no user's saved slot was
overwritten for testing. Write first syncs a local target backup, sends once,
and compares all mapped non-system settings, including inactive algorithms.
These records do not cover every undocumented byte and have no automatic restore.
