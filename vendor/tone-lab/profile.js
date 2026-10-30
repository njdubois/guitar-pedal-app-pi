// Protocol facts checked against the locally installed BOSS Tone Studio MkII 2.1.0.
// Status controls correspond to the editor's visible knobs, including gain 0–100.
import { effectParameters, effectReadBlocks } from './effects.js';
import { mkiii } from './mkiii-profile.js';
import { matchesMkiiPort } from './midi-common.js';
const knob = (offset, min = 0, max = 100, extra = {}) => ({
  address: [0x60, 0x00, 0x06, 0x50 + offset], min, max, offset: 0, ...extra,
});

export const mkii = {
  id: 'mkii',
  name: 'BOSS Katana MkII',
  portMatcher: matchesMkiiPort,
  modelId: [0x00, 0x00, 0x00, 0x33],
  identityFamily: [0x33, 0x03],
  modelCodes: [0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b],
  communicationLevel: 8,
  editorAddress: [0x7f, 0x00, 0x00, 0x01],
  levelAddress: [0x7f, 0x00, 0x00, 0x00],
  snapshotAddress: [0x60, 0x00, 0x06, 0x50],
  snapshotLength: 13,
  effectReadBlocks,
  parameters: {
    ampType: knob(0, 0, 4, { values: { acoustic: 0, clean: 1, crunch: 2, lead: 3, brown: 4 } }),
    gain: knob(1),
    bass: knob(3),
    middle: knob(4),
    treble: knob(5),
    presence: knob(6),
    booster: knob(7, -1, 100, { offset: 1 }),
    mod: knob(8, -1, 100, { offset: 1 }),
    fx: knob(9, -1, 100, { offset: 1 }),
    delay: knob(10, -1, 100, { offset: 1 }),
    reverb: knob(11, -1, 100, { offset: 1 }),
    variation: knob(12, 0, 1, { boolean: true }),
    ...effectParameters,
  },
};

export function getProfile(id = 'mkii') {
  if (id === 'mkii') return mkii;
  if (id === 'mkiii') return mkiii;
  throw new Error(`Unsupported Katana profile "${id}". The native CLI supports mkii and mkiii; use the browser interface for GO:2 guitar controls.`);
}

export function encodeValue(parameter, value) {
  if (parameter.values) return parameter.values[value];
  if (parameter.boolean) return Number(value);
  return value / (parameter.scale ?? 1) + parameter.offset;
}

export function encodeData(parameter, value) {
  const encoded = encodeValue(parameter, value);
  const radix = parameter.radix ?? 128;
  return Array.from({ length: parameter.size ?? 1 }, (_, index) =>
    Math.floor(encoded / radix ** ((parameter.size ?? 1) - 1 - index)) % radix);
}

export function decodeData(parameter, data) {
  if (data.length !== (parameter.size ?? 1)) return null;
  const radix = parameter.radix ?? 128;
  if (data.some(value => !Number.isInteger(value) || value < 0 || value >= radix)) return null;
  return decodeValue(parameter, data.reduce((value, byte) => value * radix + byte, 0));
}

export function decodeValue(parameter, value) {
  if (parameter.values) return Object.keys(parameter.values).find(key => parameter.values[key] === value) ?? null;
  if (parameter.boolean) return value === 0 ? false : value === 1 ? true : null;
  const decoded = (value - parameter.offset) * (parameter.scale ?? 1);
  return decoded >= parameter.min && decoded <= parameter.max ? decoded : null;
}
