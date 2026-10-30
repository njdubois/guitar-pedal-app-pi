import { delay } from './async.js';
import { IDENTITY_REQUEST, parseIdentity, parseDt1, addressNumber, rq1, dt1 } from './sysex.js';
import { decodeValue, encodeData } from './profile.js';
import { validatePlan, orderedChanges } from './plan.js';

export class Katana {
  constructor(transport, profile) {
    this.transport = transport;
    this.profile = profile;
    this.deviceId = null;
    this.editor = false;
  }

  async connect() {
    const bytes = await this.transport.exchange(IDENTITY_REQUEST, incoming =>
      incoming[0] === 0xf0 && incoming[1] === 0x7e && incoming[3] === 0x06 && incoming[4] === 0x02 ? incoming : null);
    const identity = parseIdentity(bytes, this.profile);
    if (!identity) throw new Error(`The connected device is not a supported ${this.profile.name.replace(/^BOSS /, '')}. Select the matching amplifier model and MIDI ports.`);
    this.deviceId = identity.deviceId;
    const level = await this.readBlock(this.profile.levelAddress, 1);
    if (level[0] !== this.profile.communicationLevel) throw new Error(`Unsupported editor communication level ${level[0]}; this profile expects ${this.profile.communicationLevel}.`);
    await this.transport.send(dt1(this.profile.modelId, this.deviceId, this.profile.editorAddress, [1]));
    this.editor = true;
    await delay(50);
    return identity;
  }

  async readBlock(address, size, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.deviceId === null) throw new Error('Identify the Katana before querying parameters.');
    const start = addressNumber(address);
    const values = new Array(size).fill(null);
    return this.transport.exchange(rq1(this.profile.modelId, this.deviceId, address, size), incoming => {
      if (!Array.isArray(incoming) && !ArrayBuffer.isView(incoming)) return null;
      const bytes = Array.from(incoming);
      if (bytes.slice(1, -1).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 127)) return null;
      const reply = parseDt1(bytes, this.profile, this.deviceId);
      if (!reply) return null;
      const offset = addressNumber(reply.address) - start;
      for (let i = 0; i < reply.data.length; i++) {
        if (offset + i >= 0 && offset + i < size) {
          if (values[offset + i] !== null && values[offset + i] !== reply.data[i]) {
            throw new Error('Katana returned conflicting values while reading a block. Read again while the tone is unchanged.');
          }
          values[offset + i] = reply.data[i];
        }
      }
      return values.every(value => value !== null) ? values : null;
    }, 4000, { signal });
  }

  async snapshot({ effects = false } = {}) {
    const bytes = await this.readBlock(this.profile.snapshotAddress, this.profile.snapshotLength);
    const base = addressNumber(this.profile.snapshotAddress);
    const settings = Object.fromEntries(Object.entries(this.profile.parameters).filter(([, p]) => !p.group).map(([key, p]) => [
      key, decodeValue(p, bytes[addressNumber(p.address) - base]),
    ]));
    if (effects) {
      // Requests remain sequential to avoid interleaving replies on the device.
      for (const block of this.profile.effectReadBlocks ?? []) {
        const data = await this.readBlock(block.address, block.size);
        const start = addressNumber(block.address);
        for (const [key, p] of Object.entries(this.profile.parameters)) {
          if (p.group !== block.group) continue;
          const offset = addressNumber(p.address) - start;
          const raw = data.slice(offset, offset + (p.size ?? 1)).reduce((value, byte) => value * 128 + byte, 0);
          settings[key] = decodeValue(p, raw);
        }
      }
    }
    const invalid = Object.entries(settings).filter(([, value]) => value === null).map(([key]) => key);
    if (invalid.length) throw new Error(`The Katana returned unmapped values for ${invalid.join(', ')}. The settings snapshot cannot be validated.`);
    return settings;
  }

  async apply(plan, expectedBefore = null, { restore = false } = {}) {
    validatePlan(plan, this.profile, { restore });
    if (!this.editor) throw new Error('Connect the Katana before applying a tone plan.');
    const effects = Object.keys({ ...plan.changes, ...expectedBefore }).some(key => this.profile.parameters[key]?.group);
    const before = await this.snapshot({ effects });
    if (expectedBefore && Object.entries(before).some(([key, value]) => expectedBefore[key] !== value)) {
      throw new Error('The Katana settings changed while the AI was preparing this tone. Run the request again using the current settings.');
    }
    let sent = 0;
    try {
      // Validate the whole plan first, then send only allowlisted temporary controls.
      // Changing a type or an assigned knob can affect detailed settings. Apply
      // types first, assigned knobs next, explicit details next, on/off last.
      for (const [key, value] of orderedChanges(plan, this.profile)) {
        const p = this.profile.parameters[key];
        await this.transport.send(dt1(this.profile.modelId, this.deviceId, p.address, encodeData(p, value)));
        sent++;
        await delay(30);
      }
      await delay(100);
      const after = await this.snapshot({ effects });
      const mismatches = Object.keys(plan.changes).filter(key => after[key] !== plan.changes[key]);
      if (mismatches.length) throw new Error(`Readback did not match for: ${mismatches.join(', ')}.`);
      const changed = Object.keys(plan.changes).filter(key => before[key] !== after[key]);
      return { before, after, changed, verified: true };
    } catch (error) {
      error.before = before;
      error.sent = sent;
      throw error;
    }
  }

  async close() {
    try {
      if (this.editor && !this.transport.failure) await this.transport.send(dt1(this.profile.modelId, this.deviceId, this.profile.editorAddress, [0]));
    } finally {
      this.editor = false;
      await this.transport.close();
    }
  }
}
