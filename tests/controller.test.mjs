import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { go2 } from '../vendor/tone-lab/go-profile.js';
import { mkii } from '../vendor/tone-lab/profile.js';
import { loadTone, applyTone, profiles, toneDocument, snapshotDocument } from '../katana_tones.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('both GO:2 local tone plans pass the exact Tone Lab plan validator', async () => {
  for (const name of ['clean', 'drive']) {
    const tone = await loadTone(path.join(ROOT, `tones/go2/${name}.json`), go2);
    assert.equal(tone.restore, false);
    assert.equal(tone.plan.changes.delay2Enabled, false);
  }
});

test('both MkII local tone plans pass the exact Tone Lab plan validator', async () => {
  for (const name of ['clean', 'drive']) {
    const tone = await loadTone(path.join(ROOT, `tones/mkii/${name}.json`), mkii);
    assert.equal(tone.restore, false);
    assert.equal(Object.hasOwn(tone.plan.changes, 'delay2Enabled'), false);
  }
});

test('wrong profile, persistent backup, and unsupported amp values fail before MIDI', async () => {
  const goPlan = JSON.parse(await readFile(path.join(ROOT, 'tones/go2/clean.json')));
  assert.throws(() => toneDocument(goPlan, mkii), /uses go2/);
  assert.throws(() => toneDocument({ blocks: [], profile: 'go2' }, go2), /Device-memory backups/);
  assert.throws(() => toneDocument({ explanation: 'invalid', changes: { gain: 101 } }, go2), /integer from 0 to 100/);
  assert.throws(() => toneDocument({ explanation: 'invalid', changes: { inventedControl: 7 } }, go2), /Unsupported parameter/);
});

test('capture refuses an incomplete snapshot and retains captured amp profile', () => {
  assert.throws(() => snapshotDocument(go2, { gain: 40 }), /complete amp and effect/);
});

test('amp snapshot is durably saved before the driver receives any write', async () => {
  const tone = await loadTone(path.join(ROOT, 'tones/go2/clean.json'), go2);
  const settings = {};
  for (const [key, p] of Object.entries(go2.parameters)) {
    if (p.algorithm && settings[`${p.group}Type`] !== p.algorithm) continue;
    settings[key] = p.values ? Object.keys(p.values)[0]
      : p.boolean ? false : Math.max(0, p.min ?? 0);
  }
  Object.assign(settings, { modType: 'chorus', fxType: 'chorus' });
  Object.assign(settings, { ampType: 'crunch', gain: 74, boosterEnabled: true });
  const events = [];
  const fakeDriver = {
    profile: go2,
    async snapshot() { events.push('read'); return structuredClone(settings); },
    async apply(plan, expected, options) {
      events.push('write');
      assert.equal(expected.gain, 74);
      assert.equal(options.restore, false);
      assert.equal(plan.changes.gain, 25);
      return { changed: ['gain'], verified: true };
    },
  };
  const result = await applyTone(fakeDriver, tone, { saveBefore: async saved => {
    events.push('backup');
    assert.equal(saved.profile, 'go2');
    assert.equal(saved.settings.gain, 74);
    assert.equal(saved.kind, 'pi-pedal-tone-snapshot');
  } });
  assert.equal(result.verified, true);
  assert.deepEqual(events, ['read', 'backup', 'write']);
});

test('full snapshot files apply a profile-validated complete tone', () => {
  const settings = {};
  for (const [key, p] of Object.entries(go2.parameters)) {
    if (p.algorithm && settings[`${p.group}Type`] !== p.algorithm) continue;
    settings[key] = p.values ? Object.keys(p.values)[0]
      : p.boolean ? false : Math.max(0, p.min ?? 0);
  }
  Object.assign(settings, { modType: 'chorus', fxType: 'chorus' });
  const snapshot = snapshotDocument(go2, settings);
  const recalled = toneDocument(snapshot, go2);
  assert.equal(recalled.restore, true);
  assert.deepEqual(recalled.plan.changes, Object.fromEntries(Object.entries(settings).filter(([key])=>go2.parameters[key].scope !== 'system')));
  assert.equal(snapshot.version, 2);
  assert.equal(Object.hasOwn(snapshot.settings, 'globalEqEnabled'), false);
  assert.throws(() => toneDocument(snapshot, mkii), /selected amp profile/);
});

test('MkII stays a distinct, explicitly selected profile', () => {
  assert.equal(profiles.mkii.id, 'mkii');
  assert.equal(profiles.go2.id, 'go2');
  assert.notDeepEqual(mkii.modelId, go2.modelId);
});
