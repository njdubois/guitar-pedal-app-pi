// Raspberry Pi USB MIDI adapter and local GO:2 tone editor.
// Persistent memory writes use only the explicit write-memory command.
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { LinuxMidi } from './linux_midi.mjs';
import { mkii } from './vendor/tone-lab/profile.js';
import { go2 } from './vendor/tone-lab/go-profile.js';
import { Katana } from './vendor/tone-lab/katana.js';
import { GoKatana } from './vendor/tone-lab/go-katana.js';
import { validatePlan, validateSettings } from './vendor/tone-lab/plan.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const profiles = { go2, mkii };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function toneDocument(document, profile) {
  if (!object(document)) throw new Error('Tone file must be a JSON object.');
  if (document.profile && document.profile !== profile.id) throw new Error(`Tone file uses ${document.profile}; selected amp profile is ${profile.id}.`);
  if (document.restore || document.blocks || document.backup || document.kind && document.kind !== 'pi-pedal-tone-snapshot') {
    throw new Error('Use a Tone Lab Save plan file or a snapshot captured by this controller. Device-memory backups and restoration records are not pedal tone plans.');
  }
  if (document.kind === 'pi-pedal-tone-snapshot') {
    if (![1, 2].includes(document.version) || document.profile !== profile.id) throw new Error('Unsupported snapshot version or profile.');
    validateSettings(document.settings, profile, { complete: true, legacy: document.version === 1 });
    const changes = Object.fromEntries(Object.entries(document.settings).filter(([key]) => profile.parameters[key].writable !== false && profile.parameters[key].scope !== 'system'));
    const plan = { explanation: 'Recall locally captured supported tone settings.', changes };
    return { plan: validatePlan(plan, profile, { restore: true }), restore: true };
  }
  if (document.kind || document.settings) throw new Error('Unrecognized snapshot format.');
  return { plan: validatePlan(document.plan ?? document, profile), restore: false };
}

export function snapshotDocument(profile, settings) {
  validateSettings(settings, profile, { complete: true });
  return { kind: 'pi-pedal-tone-snapshot', version: 2, profile: profile.id,
    createdAt: new Date().toISOString(), settings: Object.fromEntries(Object.entries(settings).filter(([key]) => profile.parameters[key].scope !== 'system')) };
}

export async function loadTone(filename, profile) {
  const data = await readFile(filename);
  if (data.length > 1024 * 1024) throw new Error('Tone file exceeds 1 MB.');
  return toneDocument(JSON.parse(data.toString('utf8')), profile);
}

export async function applyTone(driver, tone, { saveBefore = async () => {} } = {}) {
  // A full live read establishes current values and algorithm context.
  const before = await driver.snapshot({ effects: true });
  validatePlan(tone.plan, driver.profile, { restore: tone.restore, current: before });
  const previous = snapshotDocument(driver.profile, before);
  const systemSettings = Object.fromEntries(Object.entries(before).filter(([key])=>driver.profile.parameters[key].scope === 'system'));
  if (Object.keys(systemSettings).length) previous.systemSettings = systemSettings;
  await saveBefore(previous);
  return driver.apply(tone.plan, before, { restore: tone.restore });
}

function makeDriver(transport, profile) {
  return profile === go2 ? new GoKatana(transport, profile) : new Katana(transport, profile);
}

async function withDriver(profile, options, operation) {
  const transport = new LinuxMidi();
  const driver = makeDriver(transport, profile);
  let failure;
  const stop = () => {
    process.exitCode = 130;
    // Close the editor and release the USB port before aborting in-flight reads.
    void driver.close().catch(error => console.error(`Katana cleanup: ${error.message}`));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await transport.open(profile, options);
    await driver.connect();
    return await operation(driver);
  } catch (error) { failure = error; throw error; }
  finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await driver.close(); }
    catch (error) { if (!failure) throw error; }
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string', default: 'go2' }, file: { type: 'string' },
    bank: {type:'string'}, channel: {type:'string'}, out: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
    'state-dir': { type: 'string', default: path.join(ROOT, '.state') },
    help: { type: 'boolean', default: false },
  } });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(`Local pedal tone loader (GO:2 guitar mode or Katana MkII)
  node katana_tones.mjs ports
  node katana_tones.mjs validate --profile go2 --file tones/go2/clean.json
  node katana_tones.mjs read --profile go2
  node katana_tones.mjs capture --profile go2 --out tones/go2/my-tone.json
  node katana_tones.mjs apply --profile go2 --file tones/go2/clean.json
Optional: --input EXACT_PORT_NAME --output EXACT_PORT_NAME --state-dir PATH
  node katana_tones.mjs recall-memory --bank 1 --channel A\n  node katana_tones.mjs write-memory --bank 1 --channel A\nOnly write-memory overwrites onboard preset memory; it backs up the target first.`);
    return;
  }
  const profile = profiles[values.profile];
  if (!profile) throw new Error('Supported profiles: go2, mkii. Original GO and original Katana are not mapped.');
  if (positionals.length !== 1 || !['presence', 'schema', 'ports', 'validate', 'read', 'capture', 'apply', 'recall-memory', 'write-memory'].includes(command)) throw new Error('Unknown command. Use --help.');
  if (command === 'schema') {
    console.log(JSON.stringify(profile.parameters));
    return;
  }
  if (command === 'presence') {
    const transport = new LinuxMidi();
    try {
      const ports = await transport.request('list');
      for (const direction of ['input', 'output']) {
        if (!ports[direction + 's'].some(port => values[direction] ? port.name === values[direction] : profile.portMatcher(port))) throw new Error('Amp port disconnected.');
      }
      console.log(JSON.stringify({ present: true }));
    } finally { await transport.close(); }
    return;
  }
  if (command === 'ports') {
    const transport = new LinuxMidi();
    try { console.log(JSON.stringify(await transport.request('list'), null, 2)); }
    finally { await transport.close(); }
    return;
  }
  let tone;
  if (['validate', 'apply'].includes(command)) {
    if (!values.file) throw new Error('--file is required.');
    tone = await loadTone(values.file, profile);  // Validate before opening MIDI.
    if (command === 'validate') {
      console.log(JSON.stringify({ valid: true, profile: profile.id, file: values.file,
        parameters: Object.keys(tone.plan.changes), snapshot: tone.restore }));
      return;
    }
  }
  if (command === 'capture' && !values.out) throw new Error('--out is required.');
  let slot;
  if (['recall-memory','write-memory'].includes(command)) {
    const bank=Number(values.bank), channel=values.channel;
    if(profile!==go2 || !Number.isInteger(bank) || bank<1 || bank>10 || !['A','B','C'].includes(channel)) throw new Error('GO:2 memories require --bank 1..10 --channel A|B|C.');
    slot=(bank-1)*3+'ABC'.indexOf(channel);
  }
  const options = { input: values.input, output: values.output };
  const result = await withDriver(profile, options, async driver => {
    if(command==='recall-memory') return driver.recallMemory(slot);
    if(command==='write-memory') {
      const dir=path.resolve(values['state-dir'],'memory-backups');
      await mkdir(dir,{recursive:true});
      const backup=path.join(dir,`${Date.now()}-${randomUUID()}-${values.bank}${values.channel}.json`);
      try {
        const result=await driver.writeMemory(slot, async before=>{
          const file=await open(backup,'wx');
          try {
            await file.writeFile(JSON.stringify({kind:'go2-memory-backup',version:1,target:{bank:Number(values.bank),channel:values.channel},createdAt:new Date().toISOString(),...before},null,2)+'\n');
            await file.sync();
          } finally {await file.close();}
        });
        return {...result,backup};
      } catch(error) {
        error.message += ` Target backup, if created: ${backup}. Read the amp before retrying; no automatic retry was made.`;
        throw error;
      }
    }
    if (command === 'read') {
      const settings = await driver.snapshot({ effects: true });
      return { profile: profile.id, settings, allSettings: driver.reader?.allSettings ?? settings, ...(profile===go2 ? {memory:await driver.currentSlot()} : {}) };
    }
    if (command === 'capture') {
      const snapshot = snapshotDocument(profile, await driver.snapshot({ effects: true }));
      await writeFile(values.out, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
      return { captured: true, file: values.out, profile: profile.id };
    }
    const historyDir = path.resolve(values['state-dir'], 'history');
    await mkdir(historyDir, { recursive: true });
    const history = path.join(historyDir, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
    let record;
    try {
      const applied = await applyTone(driver, tone, { saveBefore: async snapshot => {
        record = { ...snapshot, requestedFile: path.resolve(values.file), status: 'pending' };
        await writeFile(history, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      } });
      await writeFile(history, JSON.stringify({ ...record, status: 'verified', after: applied.after }, null, 2) + '\n');
      return { applied: true, verified: true, profile: profile.id, changed: applied.changed, settings: applied.after, allSettings: driver.reader?.allSettings ?? applied.after, history };
    } catch (error) {
      if (record) {
        await writeFile(history, JSON.stringify({ ...record, status: 'failed', error: error.message,
          sent: error.sent, writeAttempted: error.writeAttempted }, null, 2) + '\n').catch(() => {});
        error.message += ` Previous supported settings: ${history}. Do not assume a failed operation left the amp unchanged.`;
      }
      throw error;
    }
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Katana: ${error.message}`); process.exitCode ||= 1; });
}
