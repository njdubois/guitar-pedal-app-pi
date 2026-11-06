import test from 'node:test';
import assert from 'node:assert/strict';
import {selectAmp, builtinLooper} from '../ui/amp-setup.js';
import {mkii, encodeData} from '../vendor/tone-lab/profile.js';
import {Katana} from '../vendor/tone-lab/katana.js';
import {dt1, parseDt1, addressNumber, IDENTITY_REQUEST} from '../vendor/tone-lab/sysex.js';
import {snapshotDocument, toneDocument, applyTone} from '../katana_tones.mjs';

test('switching the GO setup to MkII preserves wiring and removes incompatible actions in every position', () => {
  const config = {amp: {profile: 'go2', input: 'GO', output: 'GO'}, looper: {engine: 'builtin'}, switches: [
    {gpio: 22, actions: [{type: 'looper', command: 'record'}, {type: 'looper', command: 'clear'}],
      position_actions: {open: [{type: 'channel', bank: 1, channel: 'A'}], closed: [{type: 'tone', file: 'go.json'}]}},
    {gpio: 27, actions: [{type: 'tone', file: 'mkii.json'}]},
  ]};
  assert.equal(selectAmp(config, 'mkii', [{file: 'go.json', profile: 'go2'}, {file: 'mkii.json', profile: 'mkii'}]), 2);
  assert.equal(builtinLooper(config), true);
  assert.equal(config.amp.input, null);
  assert.equal(config.switches[0].gpio, 22);
  assert.equal(config.switches[0].actions[0].command, 'record');
  assert.equal(config.switches[0].actions[1].command, 'clear');
  assert.equal(config.switches[0].position_actions.open[0].type, 'event');
  assert.equal(config.switches[0].position_actions.closed[0].type, 'event');
  assert.equal(config.switches[1].actions[0].file, 'mkii.json');
});

// Simulate the amp's byte-addressed temporary memory, including fragmented
// replies. This tests the actual MkII driver rather than replacing its methods.
test('MkII connects, captures and restores a tone with verified readback and editor cleanup', async () => {
  const memory = new Map();
  for (const p of Object.values(mkii.parameters)) {
    const value = p.values ? Object.keys(p.values)[0] : p.boolean ? false : p.min;
    encodeData(p, value).forEach((byte, index) => memory.set(addressNumber(p.address) + index, byte));
  }
  memory.set(addressNumber(mkii.levelAddress), mkii.communicationLevel);
  const writes = [];
  let closed = false;
  const transport = {
    async exchange(request, predicate) {
      if (request.toString() === IDENTITY_REQUEST.toString()) {
        return predicate([0xf0, 0x7e, 16, 6, 2, 0x41, 0x33, 3, 0, 0, 5, 0, 0, 0, 0xf7]);
      }
      const address = request.slice(8, 12), start = addressNumber(address);
      const size = addressNumber(request.slice(12, 16));
      const data = Array.from({length: size}, (_, i) => memory.get(start + i) ?? 0);
      let result;
      // Single-byte packets also exercise accumulation of multi-byte values.
      const {toAddress} = await import('../vendor/tone-lab/sysex.js');
      for (let i = 0; i < size; i++) result = predicate(dt1(mkii.modelId, 16, toAddress(start + i), [data[i]]));
      return result;
    },
    async send(bytes) {
      const write = parseDt1(bytes, mkii, 16);
      assert.ok(write);
      writes.push(write);
      write.data.forEach((byte, i) => memory.set(addressNumber(write.address) + i, byte));
    },
    async close() { closed = true; },
  };
  const driver = new Katana(transport, mkii);
  await driver.connect();
  const captured = snapshotDocument(mkii, await driver.snapshot({effects: true}));
  const result = await applyTone(driver, toneDocument({profile: 'mkii', plan: {explanation: 'Drive', changes: {gain: 67, delayTimeMs: 650}}}, mkii));
  assert.equal(result.after.gain, 67);
  assert.equal(result.after.delayTimeMs, 650);
  assert.equal(result.verified, true);
  await applyTone(driver, toneDocument(captured, mkii));
  assert.deepEqual(await driver.snapshot({effects: true}), captured.settings);
  await driver.close();
  assert.deepEqual(writes.at(-1), {address: mkii.editorAddress, data: [0]});
  assert.equal(closed, true);
});
