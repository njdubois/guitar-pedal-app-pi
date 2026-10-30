import { GoReader } from './go-reader.js';
import { go2 } from './go-profile.js';
import { parseIdentityReply } from './device-identity.js';
import { IDENTITY_REQUEST, dt1, rq1, parseDt1 } from './sysex.js';
import { delay } from './async.js';
import { validatePlan, validateSettings, orderedChanges } from './plan.js';
import { encodeData } from './profile.js';

// Tone application controls the GO guitar temporary buffer. Persistent writes
// use only the explicit writeMemory method below.
export class GoKatana {
  constructor(transport, profile = go2, { timeout = 4000 } = {}) {
    if (profile !== go2) throw new Error('Use the registered GO:2 profile for this driver.');
    Object.assign(this, { transport, profile, timeout, deviceId: null, reader: null });
  }

  async connect() {
    const identity = await this.transport.exchange(IDENTITY_REQUEST, parseIdentityReply, this.timeout);
    this.identity = identity;
    this.reader = new GoReader(this.transport, identity, { timeout: this.timeout });
    this.deviceId = identity.deviceId;
    return identity;
  }

  async snapshot({ signal } = {}) {
    if (!this.reader) throw new Error('Identify KATANA:GO before reading settings.');
    try {
      const { parameters } = await this.reader.snapshot({ signal, effects: true });
      return validateSettings(parameters, this.profile, { complete: true });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(`KATANA:GO: ${error.message}`, { cause: error });
    }
  }

  async probeConnection({ signal } = {}) {
    if (!this.reader) throw new Error('Identify KATANA:GO before checking its mode.');
    await this.reader.verifyGuitarMode({ signal });
  }

  async openPresetEditor() {
    if (!this.reader) throw new Error('Identify KATANA:GO before opening the preset editor.');
    await this.reader.verifyGuitarMode();
    if (this.presetEditor) return;
    // GO-specific editor command observed in the BOSS mobile capture and the
    // GO desktop editor. Normal tone reads/Apply need no editor-mode changes.
    this.presetEditor = true;
    await this.transport.send(dt1(this.profile.modelId, this.deviceId, [0x7f, 0, 0, 1], [1]));
    await delay(50);
  }

  async apply(plan, expectedBefore = null, { restore = false } = {}) {
    validatePlan(plan, this.profile, { restore });
    if (!this.reader) throw new Error('Connect KATANA:GO before applying a tone.');
    const before = await this.snapshot();
    if (expectedBefore && [...new Set([...Object.keys(before), ...Object.keys(expectedBefore)])].some(key => expectedBefore[key] !== before[key])) {
      throw new Error('KATANA:GO settings changed after the preview. Read the amp and preview again. No tone writes were sent.');
    }
    validatePlan(plan, this.profile, { restore, current: before });
    const changedTypes = new Set(this.profile.effectGroups.filter(group =>
      Object.hasOwn(plan.changes, `${group}Type`) && plan.changes[`${group}Type`] !== before[`${group}Type`]));
    let sent = 0, writeAttempted = false;
    try {
      for (const [key, value] of orderedChanges(plan, this.profile)) {
        const p = this.profile.parameters[key];
        // Re-send explicit details after a type switch even if their old value
        // happened to match: changing algorithms may reset a block's settings.
        if (value === before[key] && !(changedTypes.has(p.group) && p.order !== 1)) continue;
        await this.reader.verifyGuitarMode();
        writeAttempted = true;
        await this.transport.send(dt1(this.profile.modelId, this.deviceId, p.address, encodeData(p, value)));
        sent++;
        await delay(35);
      }
      const after = await this.snapshot();
      // Newly selected algorithms have their own defaults. Verify every explicit
      // setting plus unchanged fields outside a block whose type was changed.
      const expected = { ...Object.fromEntries(Object.entries(before).filter(([key]) =>
        key.endsWith('Enabled') || !changedTypes.has(this.profile.parameters[key].group))), ...plan.changes };
      const mismatches = Object.keys(expected).filter(key => after[key] !== expected[key]);
      if (mismatches.length) throw new Error(`KATANA:GO readback did not match for: ${mismatches.join(', ')}.`);
      return { before, after, changed: Object.keys(plan.changes).filter(key => before[key] !== after[key]), verified: true };
    } catch (error) {
      Object.assign(error, { before, sent, writeAttempted });
      if (writeAttempted) error.message += ` Original gain was ${before.gain}. Previous supported settings are available in the restore record. A failed send may have reached the amp; read it before restoring or retrying.`;
      throw error;
    }
  }

  async memorySnapshot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 29) throw new Error('Choose a GO:2 bank 1–10 and channel A/B/C.');
    const reader = new GoReader(this.transport, this.identity, {timeout:this.timeout, memorySlot:slot});
    const {parameters} = await reader.snapshot({effects:true});
    return {name:await reader.toneName(), settings:parameters, allSettings:reader.allSettings, trace:reader.trace};
  }

  async currentSlot() {
    await this.openPresetEditor();
    return this.transport.exchange(rq1(this.profile.modelId,this.deviceId,[0x7f,0,1,0],2),bytes=>{
      const reply=parseDt1(Array.from(bytes),this.profile,this.deviceId);
      if (!reply) return null;
      const key=reply.address.join(',');
      if (!['0,1,0,0','0,0,0,0','127,0,1,0'].includes(key)) return null;
      const slot=reply.data.at(-1);
      return Number.isInteger(slot) && slot>=0 && slot<30 ? {slot,bank:Math.floor(slot/3)+1,channel:'ABC'[slot%3]} : null;
    },this.timeout);
  }

  async recallMemory(slot) {
    if (!Number.isInteger(slot) || slot<0 || slot>29) throw new Error('Invalid GO:2 memory slot.');
    await this.openPresetEditor();
    await this.transport.send(dt1(this.profile.modelId,this.deviceId,[0x7f,0,1,0],[0,slot]));
    await delay(200);
    const memory=await this.currentSlot();
    if(memory.slot!==slot) throw new Error('GO:2 did not confirm the selected channel. Read the amp before retrying.');
    const settings=await this.snapshot();
    return {verified:true,settings,allSettings:this.reader.allSettings,memory};
  }

  async writeMemory(slot, saveBefore) {
    await this.openPresetEditor();
    const settings=await this.snapshot();
    const expected={...this.reader.allSettings};
    const before=await this.memorySnapshot(slot);
    await saveBefore(before); // Durable backup must succeed before the persistent command.
    await this.reader.verifyGuitarMode();
    await this.transport.send(dt1(this.profile.modelId,this.deviceId,[0x7f,0,1,4],[0,slot]));
    await delay(500);
    const after=await this.memorySnapshot(slot);
    const mismatches=Object.keys(expected).filter(key=>this.profile.parameters[key].scope!=='system' && after.allSettings[key]!==expected[key]);
    if(mismatches.length) throw new Error(`Stored channel readback differs: ${mismatches.join(', ')}. The write may have reached the amp; do not retry automatically.`);
    return {verified:true,written:true,settings,allSettings:expected,target:{slot,bank:Math.floor(slot/3)+1,channel:'ABC'[slot%3]},name:after.name};
  }

  async close() {
    try {
      if (this.presetEditor && !this.transport.failure) await this.transport.send(dt1(this.profile.modelId, this.deviceId, [0x7f, 0, 0, 1], [0]));
    } finally {
      this.presetEditor = false;
      this.reader = null;
      await this.transport.close();
    }
  }
}
