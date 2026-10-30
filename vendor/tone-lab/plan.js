import { encodeData } from './profile.js';
import { dt1, hex } from './sysex.js';

export function planSchema(profile) {
  const properties = Object.fromEntries(Object.entries(profile.parameters).filter(([, p]) => p.writable !== false).map(([name, p]) => [
    name,
    p.values ? { type: 'string', enum: Object.keys(p.values) }
      : p.boolean ? { type: 'boolean' }
        : { type: p.scale && p.scale < 1 ? 'number' : 'integer', minimum: p.min, maximum: p.max, ...(p.step ? { multipleOf: p.step } : {}) },
  ]));
  return {
    type: 'object', additionalProperties: false, required: ['explanation', 'changes'],
    properties: {
      explanation: { type: 'string', maxLength: 1000 },
      changes: { type: 'object', additionalProperties: false, properties },
    },
  };
}

export function validatePlan(plan, profile, { restore = false, current } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('The tone plan must be a JSON object.');
  if (Object.keys(plan).some(k => !['explanation', 'changes'].includes(k))) throw new Error('The tone plan has unsupported fields.');
  if (typeof plan.explanation !== 'string' || plan.explanation.length > 1000) throw new Error('The plan needs an explanation of at most 1000 characters.');
  if (!plan.changes || typeof plan.changes !== 'object' || Array.isArray(plan.changes)) throw new Error('The plan needs a changes object.');
  validateSettings(plan.changes, profile);
  for (const key of Object.keys(plan.changes)) {
    if (profile.parameters[key].writable === false) throw new Error(`${key} is read-only for ${profile.name}; its writes are not verified.`);
    const p = profile.parameters[key];
    const algorithm = plan.changes[`${p.group}Type`] ?? current?.[`${p.group}Type`];
    if (p.algorithm && algorithm !== undefined && p.algorithm !== algorithm) {
      throw new Error(`${key} requires ${p.group}Type=${p.algorithm}; the proposed effect is ${algorithm}.`);
    }
  }
  for (const group of profile.effectGroups ?? ['booster', 'mod', 'fx', 'delay', 'reverb']) {
    if (Object.hasOwn(plan.changes, group) && Object.hasOwn(plan.changes, `${group}Enabled`)
      && (plan.changes[group] >= 0) !== plan.changes[`${group}Enabled`]) {
      throw new Error(`${group} amount and ${group}Enabled request conflicting on/off states.`);
    }
    if (!restore && Object.hasOwn(plan.changes, group) && Object.keys(plan.changes).some(key =>
      profile.parameters[key].group === group && !key.endsWith('Type') && !key.endsWith('Enabled'))) {
      throw new Error(`Use either the ${group} assigned knob amount or its named detailed parameters in one plan; combining them can overwrite the same setting.`);
    }
  }
  return plan;
}

// Validate browser-supplied read state as values, without treating a full
// hardware snapshot as a requested combination of control writes.
export function validateSettings(settings, profile, { complete = false, legacy = false } = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Current settings must be a JSON object.');
  for (const [key, value] of Object.entries(settings)) {
    const p = profile.parameters[key];
    if (!p || !Object.hasOwn(profile.parameters, key)) throw new Error(`Unsupported parameter: ${key}`);
    if (p.values) {
      if (typeof value !== 'string' || !Object.hasOwn(p.values, value)) throw new Error(`Invalid ${key}: ${value}`);
    } else if (p.boolean) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
    } else if (!Number.isFinite(value) || value % (p.scale && p.scale < 1 ? p.scale : 1) !== 0 || value < p.min || value > p.max) {
      throw new Error(`${key} must be ${p.scale && p.scale < 1 ? "a number in increments of " + p.scale : "an integer"} from ${p.min} to ${p.max}.`);
    } else if (p.step && value % p.step !== 0) {
      throw new Error(`${key} must use increments of ${p.step}${p.unit ? ` ${p.unit}` : ''}.`);
    }
  }
  if (complete && Object.entries(profile.parameters).some(([key, p]) =>
    p.scope !== 'system' && (!legacy || !p.extension) && (!p.algorithm || p.algorithm === settings[`${p.group}Type`]) && !Object.hasOwn(settings, key))) throw new Error('Read the complete amp and effect settings before requesting a tone.');
  return settings;
}

// Models sometimes repeat a generic effect amount alongside explicit details.
// Check every supplied value first, then prefer the more specific controls.
// Preserve the amount's on/off meaning without writing its assigned knob.
// Manual/file plans continue to use strict validatePlan directly.
export function normalizeModelPlan(plan, profile) {
  validatePlan(plan, profile, { restore: true });
  const changes = { ...plan.changes };
  const notes = [];
  for (const group of profile.effectGroups ?? ['booster', 'mod', 'fx', 'delay', 'reverb']) {
    if (!Object.hasOwn(changes, group) || !Object.keys(changes).some(key =>
      profile.parameters[key].group === group && !key.endsWith('Type') && !key.endsWith('Enabled'))) continue;
    changes[`${group}Enabled`] ??= changes[group] >= 0;
    delete changes[group];
    notes.push(`Used the named ${group} settings; ${group} is ${changes[`${group}Enabled`] ? 'on' : 'off'}.`);
  }
  const note = notes.join(' ');
  const explanation = note ? [plan.explanation.slice(0, 1000 - note.length - 1).trimEnd(), note].filter(Boolean).join(' ') : plan.explanation;
  return validatePlan({ explanation, changes }, profile);
}

export function orderedChanges(plan, profile) {
  const order = (key, value) => value === false && profile.parameters[key].offOrder !== undefined
    ? profile.parameters[key].offOrder : profile.parameters[key].order ?? (profile.parameters[key].group ? 3 : 2);
  return Object.entries(plan.changes).sort(([a, av], [b, bv]) => order(a, av) - order(b, bv));
}

export function previewPlan(plan, profile, deviceId = 0x10, options = {}) {
  validatePlan(plan, profile, options);
  return orderedChanges(plan, profile).map(([parameter, value]) => {
    const definition = profile.parameters[parameter];
    // Offline plans have no active-color evidence. Defer their wire preview
    // until a read instead of inventing a green-bank address.
    if (definition.colorGroup && !options.current) return { parameter, value, address: null, message: null, requiresRead: true };
    const p = profile.resolveParameter?.(definition, options.current) ?? definition;
    return { parameter, value, address: hex(p.address), message: hex(dt1(profile.modelId, deviceId, p.address, encodeData(p, value))) };
  });
}

export function validateRestoreContext(record, profile, current) {
  if (!profile.contextKeys) return;
  const source = record.before ?? record.context;
  const context = Object.fromEntries(profile.contextKeys.map(key => [key, source?.[key]]));
  if (Object.values(context).some(value => value === undefined)) throw new Error('The MKIII restoration record needs its original channel and effect colors. Use a complete Tone Lab history record.');
  validateSettings(context, profile);
  if (profile.contextKeys.some(key => current[key] !== context[key])) throw new Error('The MKIII restoration belongs to a different channel or effect color. Select the original channel and colors on the amp, then read and preview restoration again.');
}
