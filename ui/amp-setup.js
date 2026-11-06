export const oscCommands = new Set(['record', 'overdub', 'undo', 'redo', 'mute', 'pause', 'reverse', 'oneshot', 'trigger']);

export function builtinLooper(config) {
  return (config.looper.engine ?? 'builtin') === 'builtin';
}

// Keep wiring and compatible actions when changing amps. Unsupported actions
// become explicit no-ops in the unsaved draft so the setup can still be saved.
export function selectAmp(config, profile, library) {
  if (!['go2', 'mkii'].includes(profile)) throw new Error('Unsupported amp profile.');
  config.amp = {...config.amp, profile, input: null, output: null};
  let cleared = 0;
  for (const pedal of config.switches) {
    const groups = [pedal.actions, ...Object.values(pedal.position_actions || {})];
    for (const actions of new Set(groups)) {
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        const incompatible = action.type === 'channel' && profile !== 'go2'
          || action.type === 'tone' && !library.some(tone => tone.file === action.file && tone.profile === profile)
          || action.type === 'looper' && !builtinLooper(config) && !oscCommands.has(action.command);
        if (incompatible) {
          actions[index] = {type: 'event', name: 'pedal.unassigned'};
          cleared++;
        }
      }
    }
  }
  return cleared;
}
