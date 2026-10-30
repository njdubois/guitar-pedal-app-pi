// Gen 3 protocol facts from BOSS Tone Studio 1.1.0. Independently represented
// here; editor assets are not bundled. See docs/mkiii-protocol-notes.md.
import { addressNumber, toAddress } from './sysex.js';

const values = entries => Object.fromEntries(entries);
export const mkiiiEffectTypes = {
  booster: values([
    ['clean-boost', 1], ['treble-boost', 2], ['mid-boost', 0], ['crunch-od', 3], ['blues-drive', 9],
    ['overdrive', 10], ['natural-od', 4], ['warm-od', 5], ['turbo-od', 12], ['t-scream', 11],
    ['distortion', 13], ['fat-ds', 6], ['dst-plus', 16], ['guv-ds', 15], ['rat', 14],
    ['metal-zone', 17], ['metal-ds', 7], ['60s-fuzz', 18], ['muff-fuzz', 19], ['oct-fuzz', 8],
    ['hm-2', 20], ['metal-core', 21], ['centa-od', 22],
  ]),
  mod: values([
    ['chorus', 23], ['flanger', 15], ['phaser', 14], ['uni-v', 18], ['tremolo', 16], ['vibrato', 20],
    ['rotary', 17], ['ring-mod', 21], ['slow-gear', 8], ['slicer', 19], ['comp', 3], ['limiter', 4],
    ['t-wah', 0], ['auto-wah', 1], ['pedal-wah', 2], ['graphic-eq', 5], ['parametric-eq', 6],
    ['guitar-sim', 7], ['ac-guitar-sim', 24], ['ac-processor', 13], ['wave-synth', 9], ['octave', 10],
    ['heavy-octave', 29], ['pitch-shifter', 11], ['harmonist', 12], ['humanizer', 22],
    ['phaser-90e', 25], ['flanger-117e', 26], ['wah-95e', 27], ['dc-30', 28], ['pedal-bend', 30],
  ]),
  delay: values(['digital', 'pan', 'stereo', 'analog', 'tape-echo', 'reverse', 'modulate', 'sde-3000'].map((key, i) => [key, i])),
  reverb: values(['plate', 'room', 'hall', 'spring', 'modulate'].map((key, i) => [key, i])),
};
mkiiiEffectTypes.fx = mkiiiEffectTypes.mod;
mkiiiEffectTypes.delay2 = mkiiiEffectTypes.delay;

export const mkiiiEffectGroups = ['booster', 'mod', 'fx', 'delay', 'delay2', 'reverb'];
export const mkiiiColorGroups = ['booster', 'mod', 'fx', 'delay', 'reverb'];
const at = (block, offset = 0) => toAddress(addressNumber([0x20, 0, block, 0]) + offset);
const parameter = (block, offset, group, extra = {}) => ({
  address: at(block, offset), group, min: 0, max: 100, offset: 0,
  colorGroup: group === 'delay2' ? 'reverb' : group, ...extra,
});
const timing = { size: 4, radix: 16, unit: 'ms' };
export const mkiiiEffectParameters = {};
for (const [i, group] of mkiiiEffectGroups.entries()) {
  mkiiiEffectParameters[`${group}Enabled`] = {
    address: at(8, i), group, min: 0, max: 1, offset: 0, boolean: true, order: 4, offOrder: 0,
  };
}
for (const [group, block] of [['booster', 0x0a], ['mod', 0x10], ['fx', 0x16]]) {
  mkiiiEffectParameters[`${group}Type`] = parameter(block, 0, group, { values: mkiiiEffectTypes[group], order: 1 });
}
for (const [name, offset, extra] of [
  ['Drive', 1, { max: 120 }], ['Bottom', 2, { min: -50, max: 50, offset: 50 }],
  ['Tone', 3, { min: -50, max: 50, offset: 50 }], ['Level', 6, {}], ['DirectMix', 7, {}],
]) mkiiiEffectParameters[`booster${name}`] = parameter(0x0a, offset, 'booster', extra);
for (const [group, block] of [['delay', 0x28], ['delay2', 0x2e]]) {
  for (const [name, offset, extra] of [
    ['Type', 0, { values: mkiiiEffectTypes[group], order: 1 }],
    ['TimeMs', 1, { ...timing, min: 1, max: 2000 }], ['Feedback', 5, {}],
    ['Level', 7, { max: 120 }], ['DirectMix', 8, {}],
  ]) mkiiiEffectParameters[`${group}${name}`] = parameter(block, offset, group, extra);
}
for (const [name, offset, extra] of [
  ['Type', 0, { values: mkiiiEffectTypes.reverb, order: 1 }],
  ['LayerMode', 1, { values: { delay: 0, 'delay-reverb': 1, reverb: 2 },
    labels: { delay: 'Delay 2', 'delay-reverb': 'Delay 2 + Reverb', reverb: 'Reverb' } }],
  ['TimeMs', 2, { min: 100, max: 10000, scale: 100, offset: -1, step: 100, unit: 'ms' }],
  ['PreDelayMs', 3, { ...timing, max: 500 }], ['Density', 9, { max: 10 }],
  ['Level', 10, {}], ['DirectMix', 11, {}], ['SpringColor', 12, {}],
]) mkiiiEffectParameters[`reverb${name}`] = parameter(0x34, offset, 'reverb', extra);

// Offsets below are written as four-byte Roland address suffixes: 0x0137
// means 01 37, i.e. 183 bytes, rather than ordinary hexadecimal 311 bytes.
const signedTone = { min: -50, max: 50, offset: 50 };
const eqGain = { min: -20, max: 20, offset: 20, unit: 'dB' };
const pitch = { min: -24, max: 24, offset: 24, unit: 'semitones' };
const recipes = {
  chorus: [['LowRate', 0x137], ['LowDepth', 0x138], ['LowLevel', 0x13a], ['HighRate', 0x13b], ['HighDepth', 0x13c], ['HighLevel', 0x13e], ['DirectMix', 0x13f]],
  flanger: [['Rate', 0x111], ['Depth', 0x112], ['Manual', 0x113], ['Resonance', 0x114], ['Level', 0x116], ['DirectMix', 0x117]],
  phaser: [['Rate', 0x10a], ['Depth', 0x10b], ['Manual', 0x10c], ['Resonance', 0x10d], ['Level', 0x10f], ['DirectMix', 0x110]],
  'uni-v': [['Rate', 0x11f], ['Depth', 0x120], ['Level', 0x121]],
  tremolo: [['WaveShape', 0x118], ['Rate', 0x119], ['Depth', 0x11a], ['Level', 0x11b]],
  vibrato: [['Rate', 0x127], ['Depth', 0x128], ['Level', 0x129]],
  rotary: [['Rate', 0x11c], ['Depth', 0x11d], ['Level', 0x11e]],
  'ring-mod': [['Frequency', 0x12b], ['Level', 0x12c], ['DirectMix', 0x12d]],
  'slow-gear': [['Sensitivity', 0x3a], ['RiseTime', 0x3b], ['Level', 0x3c]],
  slicer: [['Pattern', 0x122, { min: 1, max: 20, offset: -1 }], ['Rate', 0x123], ['TriggerSensitivity', 0x124], ['Level', 0x125], ['DirectMix', 0x126]],
  comp: [['Sustain', 0x15], ['Attack', 0x16], ['Tone', 0x17, signedTone], ['Level', 0x18]],
  limiter: [['Attack', 0x1a], ['Threshold', 0x1b], ['Release', 0x1d], ['Level', 0x1e]],
  't-wah': [['Sensitivity', 2], ['Frequency', 3], ['Peak', 4], ['DirectMix', 5], ['Level', 6]],
  'auto-wah': [['Frequency', 8], ['Peak', 9], ['Rate', 0x0a], ['Depth', 0x0b], ['DirectMix', 0x0c], ['Level', 0x0d]],
  'pedal-wah': [['Position', 0x0f], ['Minimum', 0x10], ['Maximum', 0x11], ['Level', 0x12], ['DirectMix', 0x13]],
  'graphic-eq': [...['31Hz', '62Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz', '8kHz', '16kHz', 'Level'].map((name, i) => [name, 0x1f + i, eqGain])],
  'parametric-eq': [['LowGain', 0x2b, eqGain], ['LowMidGain', 0x2e, eqGain], ['HighMidGain', 0x31, eqGain], ['HighGain', 0x32, eqGain], ['Level', 0x34, eqGain]],
  'guitar-sim': [['Low', 0x36, signedTone], ['High', 0x37, signedTone], ['Level', 0x38], ['Body', 0x39]],
  'ac-guitar-sim': [['High', 0x140, signedTone], ['Body', 0x141], ['Low', 0x142, signedTone], ['Level', 0x143]],
  'ac-processor': [['Bass', 0x103, signedTone], ['Middle', 0x104, signedTone], ['Treble', 0x106, signedTone], ['Presence', 0x107, signedTone], ['Level', 0x108]],
  'wave-synth': [['CutoffFrequency', 0x3e], ['Resonance', 0x3f], ['FilterSensitivity', 0x40], ['FilterDecay', 0x41], ['FilterDepth', 0x42], ['Level', 0x43], ['DirectMix', 0x44]],
  octave: [['Level', 0x46], ['DirectMix', 0x47]],
  'heavy-octave': [['Octave1Level', 0x15a], ['Octave2Level', 0x15b], ['DirectMix', 0x15c]],
  'pitch-shifter': [['Voice1Pitch', 0x4a, pitch], ['Voice1Fine', 0x4b, signedTone], ['Voice1PreDelayMs', 0x4c, { ...timing, max: 300 }], ['Voice1Level', 0x50],
    ['Voice2Pitch', 0x52, pitch], ['Voice2Fine', 0x53, signedTone], ['Voice2PreDelayMs', 0x54, { ...timing, max: 300 }], ['Voice2Level', 0x58], ['Feedback', 0x59], ['DirectMix', 0x5a]],
  harmonist: [['Voice1PreDelayMs', 0x5d, { ...timing, max: 300 }], ['Voice1Level', 0x61], ['Voice2PreDelayMs', 0x63, { ...timing, max: 300 }], ['Voice2Level', 0x67], ['Feedback', 0x68], ['DirectMix', 0x69]],
  humanizer: [['Sensitivity', 0x131], ['Rate', 0x132], ['Depth', 0x133], ['Manual', 0x134], ['Level', 0x135]],
  'phaser-90e': [['Script', 0x144, { boolean: true, max: 1 }], ['Speed', 0x145]],
  'flanger-117e': [['Manual', 0x146], ['Width', 0x147], ['Speed', 0x148], ['Regeneration', 0x149]],
  'wah-95e': [['Position', 0x14a], ['Minimum', 0x14b], ['Maximum', 0x14c], ['Level', 0x14d], ['DirectMix', 0x14e]],
  'dc-30': [['Mode', 0x14f, { values: { chorus: 0, echo: 1 } }], ['InputLevel', 0x150], ['ChorusIntensity', 0x151], ['EchoTimeMs', 0x152, { ...timing, min: 40, max: 600 }], ['EchoIntensity', 0x156], ['EchoLevel', 0x157], ['Tone', 0x158]],
  'pedal-bend': [['Pitch', 0x15d, pitch], ['Position', 0x15e], ['Level', 0x15f], ['DirectMix', 0x160]],
};
export const mkiiiAlgorithmFields = { mod: {}, fx: {} };
for (const group of ['mod', 'fx']) {
  for (const [algorithm, fields] of Object.entries(recipes)) {
    const prefix = algorithm.replace(/(^|-)([a-z])/g, (_, _dash, letter) => letter.toUpperCase());
    mkiiiAlgorithmFields[group][algorithm] = fields.map(([name, suffix, extra]) => {
      const offset = Math.floor(suffix / 256) * 128 + suffix % 256;
      const key = `${group}${prefix}${name}`;
      mkiiiEffectParameters[key] = parameter(group === 'mod' ? 0x1c : 0x22, offset, group, {
        algorithm, label: `${group.toUpperCase()} ${algorithm.replaceAll('-', ' ')} ${name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace('Ms', '(ms)')}`, ...extra,
      });
      return key;
    });
  }
}

export const mkiiiEffectReadBlocks = [
  { group: 'booster', address: at(0x0a), size: 8 },
  { group: 'mod', address: at(0x10), size: 1 },
  { group: 'fx', address: at(0x16), size: 1 },
  { group: 'delay', address: at(0x28), size: 9 },
  { group: 'delay2', address: at(0x2e), size: 9 },
  { group: 'reverb', address: at(0x34), size: 13 },
];

// Resolve a green-bank address against the freshly read active color.
// Delay 2 uses the REVERB color, as in the official editor's switcher.
export function resolveMkiiiParameter(p, current) {
  if (!p.colorGroup) return p;
  const color = current?.[`${p.colorGroup}Color`];
  if (!Number.isInteger(color) || color < 0 || color > 2) throw new Error('Read the MKIII active effect colors before preparing MIDI messages.');
  return { ...p, address: toAddress(addressNumber(p.address) + color * 2 * 128) };
}
