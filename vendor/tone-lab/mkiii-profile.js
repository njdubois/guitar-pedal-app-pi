import { mkiiiEffectParameters, mkiiiEffectReadBlocks, mkiiiEffectGroups, mkiiiColorGroups,
  mkiiiAlgorithmFields, resolveMkiiiParameter } from './mkiii-effects.js';
import { matchesMkiiiPort } from './midi-common.js';

const amp = (offset, extra = {}) => ({ address: [0x20, 0, 6, offset], min: 0, max: 100, offset: 0, ...extra });

// Reference-backed, hardware-unverified Gen 3 profile. It deliberately does
// not inherit MkII or GO addresses/IDs. See docs/mkiii-protocol-notes.md.
export const mkiii = {
  id: 'mkiii', name: 'BOSS Katana MKIII (Gen 3)',
  modelId: [1, 5, 7], identityFamily: [7, 5], modelCodes: [5, 6, 7, 8, 9, 10, 11],
  communicationLevel: 1, levelAddress: [0x7f, 0, 0, 0], editorAddress: [0x7f, 0, 0, 1],
  snapshotAddress: [0x20, 0, 6, 0], snapshotLength: 10,
  colorAddress: [0x20, 0, 4, 0], channelAddress: [0, 0, 0, 0],
  effectGroups: mkiiiEffectGroups, effectReadBlocks: mkiiiEffectReadBlocks,
  algorithmFields: mkiiiAlgorithmFields, resolveParameter: resolveMkiiiParameter,
  contextKeys: ['channel', ...mkiiiColorGroups.map(group => `${group}Color`)],
  selectionKey: 'tone-lab-midi-selection-mkiii-v1',
  portMatcher: matchesMkiiiPort,
  parameters: {
    ampType: amp(7, { values: { acoustic: 0, clean: 1, pushed: 2, crunch: 3, lead: 4, brown: 5 } }),
    variation: amp(9, { min: 0, max: 1, boolean: true }),
    gain: amp(0), bass: amp(2), middle: amp(3), treble: amp(4), presence: amp(5),
    channel: { address: [0, 0, 0, 0], min: 0, max: 9, offset: 0, size: 2, radix: 16, writable: false },
    ...Object.fromEntries(mkiiiColorGroups.map((group, i) => [`${group}Color`, {
      address: [0x20, 0, 4, i], min: 0, max: 2, offset: 0, writable: false,
    }])),
    ...mkiiiEffectParameters,
  },
};
