import { rq1, parseDt1, addressNumber, toAddress, hex } from './sysex.js';
import { goEffectParameters, goEffectReadBlocks } from './go-effects.js';
import { goToneReadBlocks } from './go-tone.js';
import { go2 } from './go-profile.js';
import { decodeData } from './profile.js';

// Strict, query-only GO reader. Basic diagnostics preserve the captured sequence;
// the normal controller also reads GO-specific effect types and active details.
const modelId = [0x01, 0x05, 0x0d];
const blocks = {
  mode: { address: [0x10, 0x01, 0x30, 0x00], size: 1 },
  amp: { address: [0x20, 0x00, 0x20, 0x00], size: 14 },
  effects: { address: [0x20, 0x00, 0x30, 0x00], size: 6 },
};
const ampTypes = ['acoustic', 'clean', 'crunch', 'lead', 'brown'];
const knobs = { gain: 0, volume: 1, bass: 3, middle: 4, treble: 5, presence: 10 };
const effectBlocks = ['booster', 'mod', 'fx', 'delay', 'delay2', 'reverb'];

function same(bytes, expected) {
  return Array.isArray(bytes) && bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
}

function checkIdentity(identity) {
  if (!identity || !same(identity.manufacturerId, [0x41]) || !same(identity.familyId, [0x0d, 0x05])
    || !same(identity.modelId, [0, 0]) || !Number.isInteger(identity.deviceId)
    || identity.deviceId < 0 || identity.deviceId > 0x7e) {
    throw new Error('The selected MIDI device does not match the observed KATANA:GO identity. No GO parameter requests were sent.');
  }
}

function booleanValue(value, label) {
  if (value !== 0 && value !== 1) throw new Error(`GO returned an unmapped ${label} value (${value}). No settings snapshot is available.`);
  return value === 1;
}

// Queries only: no editor negotiation or write method; an explicit memorySlot reads stored tones,
// default snapshots or automatic retries. The probe owns opening/closing ports.
export class GoReader {
  constructor(transport, identity, { timeout = 4000, trace = [], onStage = () => {}, memorySlot = null } = {}) {
    checkIdentity(identity);
    Object.assign(this, { transport, deviceId: identity.deviceId, timeout, trace, onStage, memorySlot });
  }

  async #read(block, stage, signal) {
    // GO USB replies are bounded; page-sized requests can be ignored entirely.
    if (block.size > 64) {
      const data = [];
      for (let offset=0;offset<block.size;offset+=64) data.push(...await this.#read({
        address:toAddress(addressNumber(block.address)+offset), size:Math.min(64,block.size-offset),
      },stage,signal));
      return data;
    }
    if (this.memorySlot !== null && block.address[0] === 0x20) {
      const page = (this.memorySlot + 1) * 16 + block.address[1];
      block = {...block, address:[0x20 + Math.floor(page / 128), page % 128, ...block.address.slice(2)]};
    }
    signal?.throwIfAborted();
    this.onStage(stage);
    const request = rq1(modelId, this.deviceId, block.address, block.size);
    const entry = { stage, address: hex(block.address), size: block.size, request: hex(request), replies: [] };
    this.trace.push(entry);
    const start = addressNumber(block.address);
    const values = Array(block.size).fill(null);
    return this.transport.exchange(request, incoming => {
      if (!Array.isArray(incoming) && !ArrayBuffer.isView(incoming)) return null;
      const bytes = Array.from(incoming);
      if (bytes.length > 512 || bytes.slice(1, -1).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 127)) return null;
      const reply = parseDt1(bytes, { modelId }, this.deviceId);
      if (!reply) return null;
      const offset = addressNumber(reply.address) - start;
      if (offset >= values.length || offset + reply.data.length <= 0) return null;
      // Retain bounded raw evidence without allowing unrelated traffic to finish a read.
      if (entry.replies.length < 16) entry.replies.push(hex(bytes));
      reply.data.forEach((value, index) => {
        const position = offset + index;
        if (position < 0 || position >= values.length) return;
        if (values[position] !== null && values[position] !== value) {
          throw new Error('GO sent conflicting values while reading a block. Read again while the tone is unchanged.');
        }
        values[position] = value;
      });
      return values.every(value => value !== null) ? values : null;
    }, this.timeout, { signal });
  }

  async snapshot({ signal, effects: detailedEffects = false } = {}) {
    const [mode] = await this.#read(blocks.mode, 'reading-guitar-mode', signal);
    if (mode !== 0) throw new Error(mode === 1
      ? 'GO is in bass mode. This integration supports guitar mode. Change mode in Tone Studio, close it, then read again.'
      : `GO returned an unknown mode (${mode}). No guitar parameter requests were sent.`);

    const amp = await this.#read(blocks.amp, 'reading-amplifier', signal);
    const states = await this.#read(blocks.effects, 'reading-effects', signal);

    const ampType = ampTypes[amp[12]];
    if (!ampType) throw new Error(`GO returned an unsupported guitar amp type (${amp[12]}). No settings snapshot is available.`);
    const settings = { ampType, variation: booleanValue(amp[13], 'variation') };
    for (const [key, offset] of Object.entries(knobs)) {
      const value = amp[offset];
      if (value > 100) throw new Error(`GO ${key} (${value}) exceeds the documented 0–100 range. No settings snapshot is available.`);
      settings[key] = value;
    }
    const effects = Object.fromEntries(effectBlocks.map((key, index) => [key, { enabled: booleanValue(states[index], `${key} on/off`) }]));
    let parameters;
    if (detailedEffects) {
      parameters = { ...settings, ...Object.fromEntries(effectBlocks.map(group => [`${group}Enabled`, effects[group].enabled])) };
      for (const block of goEffectReadBlocks) {
        const data = await this.#read(block, `reading-${block.group}-details`, signal);
        for (const [key, p] of Object.entries(goEffectParameters).filter(([, p]) => p.group === block.group && !p.algorithm)) {
          const offset = addressNumber(p.address) - addressNumber(block.address);
          const value = decodeData(p, data.slice(offset, offset + (p.size ?? 1)));
          if (value === null) throw new Error(`GO returned an unmapped ${key} value. No settings snapshot is available.`);
          parameters[key] = value;
        }
        effects[block.group].type = parameters[`${block.group}Type`];
      }
      // Keep every algorithm's stored controls for selection in the editor.
      // Only the selected algorithm goes into a captured/recallable tone.
      const allSettings = { ...parameters };
      for (const block of [
        {group:'mod',address:[0x20,1,0,0],size:210},
        {group:'fx',address:[0x20,1,0x10,0],size:210},
        ...goToneReadBlocks,
      ]) {
        const data = await this.#read(block, `reading-${block.group}-settings`, signal);
        const start = addressNumber(block.address);
        for (const [key,p] of Object.entries(go2.parameters)) {
          const offset = addressNumber(p.address) - start;
          if (offset < 0 || offset + (p.size ?? 1) > data.length) continue;
          const value = decodeData(p,data.slice(offset,offset+(p.size ?? 1)));
          if (value === null) {
            if (!p.algorithm || p.algorithm === parameters[`${p.group}Type`]) throw new Error(`GO returned an unmapped ${key} value. Read the amp again.`);
            continue;
          }
          allSettings[key] = value;
          if (!p.algorithm || p.algorithm === parameters[`${p.group}Type`]) parameters[key] = value;
        }
      }
      // Selector blocks precede their parameters, so all active values are known.
      for (const [key,p] of Object.entries(go2.parameters)) {
        if (p.algorithm && p.algorithm !== parameters[`${p.group}Type`]) delete parameters[key];
      }
      this.allSettings = allSettings;
      // A type edit during a multi-block read must never produce mixed context.
      for (const block of goEffectReadBlocks) {
        const [type] = await this.#read({ ...block, size: 1 }, `checking-${block.group}-type`, signal);
        if (type !== goEffectParameters[`${block.group}Type`].values[parameters[`${block.group}Type`]]) {
          throw new Error(`GO ${block.group} type changed during the read. Read again while the tone is unchanged.`);
        }
      }
    }
    const [lastMode] = await this.#read(blocks.mode, 'checking-guitar-mode', signal);
    if (lastMode !== mode) throw new Error('GO mode changed during the read. No settings snapshot is available; read again.');
    return { mode: 'guitar', settings, effects, ...(parameters ? { parameters } : {}) };
  }

  async toneName() {
    const bytes = await this.#read({address:[0x20,0,0,4],size:16}, 'reading-tone-name');
    return String.fromCharCode(...bytes).trim();
  }

  async verifyGuitarMode({ signal } = {}) {
    const [mode] = await this.#read(blocks.mode, 'checking-guitar-mode', signal);
    if (mode !== 0) throw new Error('KATANA:GO MODE CHANGED: guitar mode is required. Read the amp before previewing again.');
  }
}
