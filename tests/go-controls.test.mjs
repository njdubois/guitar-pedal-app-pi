import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GoReader} from '../vendor/tone-lab/go-reader.js';
import {go2} from '../vendor/tone-lab/go-profile.js';
import {encodeData,decodeData} from '../vendor/tone-lab/profile.js';
import {validateSettings,validatePlan} from '../vendor/tone-lab/plan.js';
import {hex} from '../vendor/tone-lab/sysex.js';
import {snapshotDocument,toneDocument} from '../katana_tones.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/go2-wire.json',import.meta.url)));
const bytes=s=>s.split(' ').map(b=>parseInt(b,16));

test('the complete editor decodes real GO:2 wire captures including inactive effects',async()=>{
 let index=0;
 const transport={async exchange(request,predicate){
  const record=captured.reads[index++];
  assert.equal(hex(request),record.request);
  let result;
  for(const reply of record.replies)result=predicate(bytes(reply));
  assert.ok(result,record.stage);
  return result;
 }};
 const reader=new GoReader(transport,captured.identity);
 const result=await reader.snapshot({effects:true});
 assert.deepEqual(result.parameters,captured.settings);
 assert.deepEqual(reader.allSettings,captured.allSettings);
 assert.equal(Object.keys(reader.allSettings).length,Object.keys(go2.parameters).length);
 assert.equal(index,captured.reads.length);
});

test('tone volume has its own address and half-step controls encode accurately',()=>{
 assert.deepEqual(go2.parameters.volume.address,[0x20,0,0x20,1]);
 assert.deepEqual(encodeData(go2.parameters.volume,22),[22]);
 for(const key of ['soloEqLowGain','eq1Graphic31Hz','modChorusLowPreDelayMs']){
  const p=go2.parameters[key];
  assert.equal(decodeData(p,encodeData(p,1.5)),1.5);
  assert.doesNotThrow(()=>validateSettings({[key]:1.5},go2));
  assert.throws(()=>validateSettings({[key]:1.25},go2));
 }
});

test('every effect has controls; mismatched algorithms cannot be applied',()=>{
 for(const group of ['mod','fx']){
  assert.equal(Object.keys(go2.parameters[group+'Type'].values).length,28);
  for(const algorithm of Object.keys(go2.parameters[group+'Type'].values)){
   assert.ok(Object.values(go2.parameters).some(p=>p.group===group&&p.algorithm===algorithm));
  }
 }
 assert.equal(Object.keys(go2.parameters.boosterType.values).length,23);
 assert.throws(()=>validatePlan({explanation:'Wrong controls',changes:{modType:'chorus',modCompSustain:40}},go2),/requires/);
 assert.deepEqual(go2.parameters.eq1Enabled.address,[0x20,2,0x60,0]);
 assert.deepEqual(go2.parameters.eq1Position.address,[0x20,2,0x60,1]);
 assert.equal(go2.parameters.pedalFxType.values['pedal-bend'],1);
 assert.equal(go2.parameters.pedalFxType.values.wah95,2);
});

test('new captures retain all active tone fields and exclude system settings',()=>{
 const snapshot=snapshotDocument(go2,captured.settings);
 const recalled=toneDocument(snapshot,go2);
 assert.equal(snapshot.version,2);
 assert.equal(recalled.plan.changes.volume,22);
 assert.equal(recalled.plan.changes.eq2ParametricLevel,captured.settings.eq2ParametricLevel);
 assert.equal(Object.hasOwn(recalled.plan.changes,'usbLoopback'),false);
 assert.equal(Object.hasOwn(recalled.plan.changes,'globalEqEnabled'),false);
 assert.throws(()=>toneDocument({...snapshot,settings:{...snapshot.settings,volume:101}},go2));
 const incomplete=structuredClone(snapshot);delete incomplete.settings.volume;
 assert.throws(()=>toneDocument(incomplete,go2),/complete/);
});

test('version 1 captures remain usable without inventing newly mapped settings',()=>{
 const settings=Object.fromEntries(Object.entries(captured.settings).filter(([key])=>!go2.parameters[key].extension));
 const recalled=toneDocument({kind:'pi-pedal-tone-snapshot',version:1,profile:'go2',settings},go2);
 assert.equal(recalled.restore,true);
 assert.equal(Object.hasOwn(recalled.plan.changes,'volume'),false);
 assert.equal(recalled.plan.changes.gain,48);
});

test('GO memories use the GO-specific recall/store commands and back up before store',async()=>{
 const {GoKatana}=await import('../vendor/tone-lab/go-katana.js');
 const {parseDt1}=await import('../vendor/tone-lab/sysex.js');
 const events=[];
 const driver=new GoKatana({send:async bytes=>events.push(parseDt1(bytes,go2,16))});
 driver.deviceId=16;driver.openPresetEditor=async()=>{};
 driver.reader={allSettings:{volume:22},verifyGuitarMode:async()=>{}};
 driver.snapshot=async()=>({volume:22});
 driver.currentSlot=async()=>({slot:29,bank:10,channel:'C'});
 driver.memorySnapshot=async()=>({allSettings:{volume:22},name:'Saved'});
 await assert.rejects(driver.writeMemory(29,async()=>{throw new Error('disk full');}),/disk full/);
 assert.equal(events.length,0);
 const result=await driver.writeMemory(29,async()=>events.push('backup'));
 assert.equal(events[0],'backup');
 assert.deepEqual(events[1].address,[127,0,1,4]);assert.deepEqual(events[1].data,[0,29]);
 assert.equal(result.verified,true);
 await driver.recallMemory(29);
 assert.deepEqual(events[2].address,[127,0,1,0]);assert.deepEqual(events[2].data,[0,29]);
 await assert.rejects(driver.recallMemory(30),/Invalid/);
 driver.memorySnapshot=async()=>({allSettings:{volume:23}});
 await assert.rejects(driver.writeMemory(0,async()=>{}),/readback differs/);
});

test('stored memory reader offsets GO pages without moving live/global mode queries',async()=>{
 const {dt1,rq1}=await import('../vendor/tone-lab/sysex.js');
 const identity=captured.identity;
 for(const slot of [0,7,29]){
  const transport={async exchange(request,predicate){
    const page=(slot+1)*16;
    assert.equal(hex(request),hex(rq1(go2.modelId,identity.deviceId,[0x20+Math.floor(page/128),page%128,0,4],16)));
    return predicate(dt1(go2.modelId,identity.deviceId,[0x20+Math.floor(page/128),page%128,0,4],Array.from('Test tone       ',c=>c.charCodeAt(0))));
  }};
  assert.equal(await new GoReader(transport,identity,{memorySlot:slot}).toneName(),'Test tone');
 }
});
