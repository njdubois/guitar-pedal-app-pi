import { goToneParameters } from './go-tone.js';
import { goEffectParameters } from './go-effects.js';
// GO-specific guitar controls; protocol sources and hardware verification
// are documented in docs/go2-protocol-notes.md.
const knob = (offset, extra = {}) => ({ address: [0x20, 0, 0x20, offset], min: 0, max: 100,
  offset: 0, ...extra });
const groups = ['booster', 'mod', 'fx', 'delay', 'delay2', 'reverb'];

export const go2 = {
  id: 'go2', name: 'BOSS KATANA:GO:2', modelId: [1, 5, 13],
  selectionKey: 'tone-lab-midi-selection-go2-v1',
  portMatcher: port => /katana[\s:_-]*go\b/i.test(`${port.name ?? ''} ${port.model ?? ''}`),
  effectGroups: [...groups, 'eq1', 'eq2', 'pedalFx'],
  parameters: {
    ampType: knob(12, { values: { acoustic: 0, clean: 1, crunch: 2, lead: 3, brown: 4 } }),
    variation: knob(13, { boolean: true }),
    gain: knob(0, { writable: true }),
    volume: knob(1, { label: 'Tone volume', extension: true }),
    bass: knob(3), middle: knob(4), treble: knob(5), presence: knob(10),
    ...Object.fromEntries(groups.map((group, index) => [`${group}Enabled`, {
      address: [0x20, 0, 0x30, index], boolean: true, group, order: 4, offOrder: 0,
    }])),
    ...goEffectParameters,
    ...goToneParameters,
  },
};
