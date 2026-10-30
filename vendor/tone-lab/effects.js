// Factual IDs, ranges and addresses checked against the installed MkII editor's
// address_map.js and the select-box labels/list_order in item.json/layout.div.
const catalog = entries => Object.fromEntries(entries.map(([key, id, label]) => [key, { id, label }]));
export const effectTypes = {
  booster: catalog([
    ['clean-boost', 1, 'Clean Boost'], ['treble-boost', 2, 'Treble Boost'], ['mid-boost', 0, 'Mid Boost'],
    ['crunch-od', 3, 'Crunch OD'], ['blues-drive', 10, 'Blues Drive'], ['overdrive', 11, 'Overdrive'],
    ['natural-od', 4, 'Natural OD'], ['warm-od', 5, 'Warm OD'], ['turbo-od', 13, 'Turbo OD'],
    ['t-scream', 12, 'T-Scream'], ['distortion', 14, 'Distortion'], ['fat-ds', 6, 'Fat DS'],
    ['dst-plus', 17, 'DST+'], ['guv-ds', 16, 'GUV DS'], ['rat', 15, 'RAT'],
    ['metal-zone', 18, 'Metal Zone'], ['metal-ds', 8, 'Metal DS'], ['60s-fuzz', 19, "'60s Fuzz"],
    ['muff-fuzz', 20, 'Muff Fuzz'], ['oct-fuzz', 9, 'Oct Fuzz'], ['hm-2', 21, 'HM-2'],
    ['metal-core', 22, 'Metal Core'], ['centa-od', 23, 'Centa OD'],
  ]),
  mod: catalog([
    ['chorus', 29, 'Chorus'], ['flanger', 20, 'Flanger'], ['phaser', 19, 'Phaser'], ['uni-v', 23, 'Uni-V'],
    ['tremolo', 21, 'Tremolo'], ['vibrato', 26, 'Vibrato'], ['rotary', 22, 'Rotary'], ['ring-mod', 27, 'Ring Mod'],
    ['slow-gear', 10, 'Slow Gear'], ['slicer', 25, 'Slicer'], ['comp', 3, 'Compressor'], ['limiter', 4, 'Limiter'],
    ['t-wah', 0, 'T.Wah'], ['auto-wah', 1, 'Auto Wah'], ['pedal-wah', 2, 'Pedal Wah'],
    ['graphic-eq', 6, 'Graphic EQ'], ['parametric-eq', 7, 'Parametric EQ'], ['guitar-sim', 9, 'Guitar Sim'],
    ['ac-guitar-sim', 31, 'Acoustic Guitar Sim'], ['ac-processor', 18, 'Acoustic Processor'],
    ['wave-synth', 12, 'Wave Synth'], ['octave', 14, 'Octave'], ['heavy-octave', 39, 'Heavy Octave'],
    ['pitch-shifter', 15, 'Pitch Shifter'], ['harmonist', 16, 'Harmonist'], ['humanizer', 28, 'Humanizer'],
    ['phaser-90e', 35, 'Phaser 90E'], ['flanger-117e', 36, 'Flanger 117E'], ['wah-95e', 37, 'Wah 95E'],
    ['dc-30', 38, 'DC-30'], ['pedal-bend', 40, 'Pedal Bend'],
  ]),
  delay: catalog([
    ['digital', 0, 'Digital'], ['pan', 1, 'Pan'], ['stereo', 2, 'Stereo'], ['analog', 7, 'Analog'],
    ['tape-echo', 8, 'Tape Echo'], ['reverse', 6, 'Reverse'], ['modulate', 9, 'Modulate'], ['sde-3000', 10, 'SDE-3000'],
  ]),
  reverb: catalog([['plate', 4, 'Plate'], ['room', 1, 'Room'], ['hall', 3, 'Hall'], ['spring', 5, 'Spring'], ['modulate', 6, 'Modulate']]),
};
effectTypes.fx = effectTypes.mod;

const control = (group, address, min, max, extra = {}) => ({ group, address, min, max, offset: 0, size: 1, ...extra });
const enabled = (group, address) => control(group, address, 0, 1, { boolean: true, order: 4 });
const type = (group, address) => control(group, address, 0, 127, {
  values: Object.fromEntries(Object.entries(effectTypes[group]).map(([key, value]) => [key, value.id])), order: 1,
});
export const effectParameters = {
  boosterEnabled: enabled('booster', [0x60, 0, 0, 0x10]),
  boosterType: type('booster', [0x60, 0, 0, 0x11]),
  boosterDrive: control('booster', [0x60, 0, 0, 0x12], 0, 120),
  boosterBottom: control('booster', [0x60, 0, 0, 0x13], -50, 50, { offset: 50 }),
  boosterTone: control('booster', [0x60, 0, 0, 0x14], -50, 50, { offset: 50 }),
  boosterLevel: control('booster', [0x60, 0, 0, 0x17], 0, 100),
  modEnabled: enabled('mod', [0x60, 0, 1, 0]),
  modType: type('mod', [0x60, 0, 1, 1]),
  fxEnabled: enabled('fx', [0x60, 0, 3, 0]),
  fxType: type('fx', [0x60, 0, 3, 1]),
  delayEnabled: enabled('delay', [0x60, 0, 5, 0]),
  delayType: type('delay', [0x60, 0, 5, 1]),
  delayTimeMs: control('delay', [0x60, 0, 5, 2], 1, 2000, { size: 2, unit: 'ms' }),
  delayFeedback: control('delay', [0x60, 0, 5, 4], 0, 100),
  delayLevel: control('delay', [0x60, 0, 5, 6], 0, 120),
  reverbEnabled: enabled('reverb', [0x60, 0, 5, 0x40]),
  reverbType: type('reverb', [0x60, 0, 5, 0x41]),
  reverbTimeMs: control('reverb', [0x60, 0, 5, 0x42], 100, 10000, { scale: 100, step: 100, offset: -1, unit: 'ms' }),
  reverbPreDelayMs: control('reverb', [0x60, 0, 5, 0x43], 0, 500, { size: 2, unit: 'ms' }),
  reverbLevel: control('reverb', [0x60, 0, 5, 0x48], 0, 100),
};

export const effectReadBlocks = [
  { group: 'booster', address: [0x60, 0, 0, 0x10], size: 9 },
  { group: 'mod', address: [0x60, 0, 1, 0], size: 2 },
  { group: 'fx', address: [0x60, 0, 3, 0], size: 2 },
  { group: 'delay', address: [0x60, 0, 5, 0], size: 8 },
  { group: 'reverb', address: [0x60, 0, 5, 0x40], size: 10 },
];

export function effectLabel(group, key, profile) {
  return profile?.parameters[`${group}Type`]?.labels?.[key] ?? effectTypes[group]?.[key]?.label
    ?? effectTypes[group === 'delay2' ? 'delay' : group]?.[key]?.label ?? key ?? 'type not read';
}

export function effectSummary(settings, profile) {
  return Object.fromEntries((profile?.effectGroups ?? ['booster', 'mod', 'fx', 'delay', 'reverb']).map(group => {
    const fields = Object.entries(profile?.parameters ?? effectParameters).filter(([key, p]) => p.group === group && settings[key] !== undefined);
    const parameters = Object.fromEntries(fields.filter(([key]) => !key.endsWith('Type') && !key.endsWith('Enabled'))
      .map(([key]) => [key.slice(group.length), settings[key]]));
    const state = settings[`${group}Enabled`] ?? (settings[group] === undefined ? null : settings[group] >= 0);
    return [group, { name: effectLabel(group, settings[`${group}Type`], profile),
      enabled: state, assignedKnob: settings[group] ?? null, parameters }];
  }));
}

export function effectLines(settings, heading = 'EFFECTS', profile) {
  return Object.entries(effectSummary(settings, profile)).map(([group, effect]) => {
    const state = effect.enabled === null ? 'state not read' : effect.enabled ? 'ON' : 'OFF';
    const knob = effect.assignedKnob === null ? 'not read' : effect.assignedKnob < 0 ? 'off' : `${effect.assignedKnob}/100`;
    const details = Object.entries(effect.parameters).map(([key, value]) => `${key}=${value}${key.endsWith('Ms') ? ' ms' : ''}`);
    const extra = details.length ? details.join(', ')
      : ['mod', 'fx'].includes(group) ? 'algorithm-specific settings not mapped' : '';
    return `[${heading}] ${group.toUpperCase()}: ${effect.name}; ${state}; assigned knob=${knob}${extra ? `; ${extra}` : ''}.`;
  });
}

export function plannedEffectLines(plan, current = null, profile) {
  return (profile?.effectGroups ?? ['booster', 'mod', 'fx', 'delay', 'reverb']).map(group => {
    const changes = Object.entries(plan.changes).filter(([key]) => key === group || (profile?.parameters ?? effectParameters)[key]?.group === group);
    const label = `[PLANNED EFFECTS] ${group.toUpperCase()}`;
    if (!changes.length) return `${label}: no changes requested${current ? `; current type=${effectLabel(group, current[`${group}Type`], profile)}` : '; current type/settings not read'}.`;
    const type = plan.changes[`${group}Type`] ?? current?.[`${group}Type`];
    const details = changes.map(([key, value]) => {
      if (key === group) return value < 0 ? 'switch OFF' : `assigned knob=${value}/100 (ON)`;
      if (key.endsWith('Type')) return `type=${effectLabel(group, value, profile)}`;
      if (key.endsWith('Enabled')) return value ? 'ON' : 'OFF';
      const p = (profile?.parameters ?? effectParameters)[key];
      return `${key.slice(group.length)}=${value}${p.unit ? ` ${p.unit}` : ` (${p.min} to ${p.max})`}`;
    });
    return `${label}: ${effectLabel(group, type, profile)}; requested ${details.join(', ')}.`;
  });
}
