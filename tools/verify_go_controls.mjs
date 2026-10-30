// Explicit hardware integration check. Changes temporary controls, then restores
// every mapped value, with tone volume held at zero during the check.
import { writeFile, mkdir } from 'node:fs/promises';
import { LinuxMidi } from '../linux_midi.mjs';
import { GoKatana } from '../vendor/tone-lab/go-katana.js';
import { go2 } from '../vendor/tone-lab/go-profile.js';
import { validateSettings } from '../vendor/tone-lab/plan.js';
import { encodeData } from '../vendor/tone-lab/profile.js';
import { dt1, rq1, parseDt1, hex } from '../vendor/tone-lab/sysex.js';
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
if (!process.argv.includes('--write-and-restore')) throw new Error('Pass --write-and-restore to run the live hardware check.');
const root = new URL('../.state/protocol-verification/',import.meta.url);
await mkdir(root,{recursive:true});
const transport = new LinuxMidi(), driver = new GoKatana(transport,go2);
const selectedGroups = process.argv.find(arg=>arg.startsWith('--groups='))?.slice(9).split(',');
const suffix = selectedGroups ? '-system' : '';
const report = {date:new Date().toISOString(),groups:selectedGroups,tests:[],restored:false};
let before, original, wrote = false, interrupted = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{interrupted=true;});
const read = async p => transport.exchange(rq1(go2.modelId,driver.deviceId,p.address,p.size??1),bytes=>{
 const reply=parseDt1(Array.from(bytes),go2,driver.deviceId);
 if(!reply||hex(reply.address)!==hex(p.address)||reply.data.length!==(p.size??1))return null;
 return reply.data;
},4000);
const write = async (key,value) => {
 validateSettings({[key]:value},go2);
 await transport.send(dt1(go2.modelId,driver.deviceId,go2.parameters[key].address,encodeData(go2.parameters[key],value)));
 await wait(35);
};
try {
 await transport.open(go2,{});report.identity=await driver.connect();
 before=await driver.snapshot(); original={...driver.reader.allSettings};
 await writeFile(new URL(`controls-before${suffix}.json`,root),JSON.stringify({before,allSettings:original,trace:driver.reader.trace},null,2));
 wrote=true; await write('volume',0);
 for(const [key,p] of Object.entries(go2.parameters)) {
  if(interrupted)throw new Error("Verification interrupted; restoring original controls.");
  if(p.writable===false || selectedGroups && !selectedGroups.includes(p.group))continue;
  const value=original[key];
  const targets=p.values?Object.keys(p.values).filter(v=>v!==value):p.boolean?[!value]:[value>(p.min??0)?value-(p.step??p.scale??1):value+(p.step??p.scale??1)];
  for(const target of targets) {
   // Keep tests quiet even when testing the tone's volume itself.
   const candidate=key==='volume'?Math.min(value,1):target;
   await write(key,candidate);
   const actual=await read(p),expected=encodeData(p,candidate);
   if(hex(actual)!==hex(expected))throw new Error(`${key}=${candidate}: read ${hex(actual)}, expected ${hex(expected)}`);
   report.tests.push({key,value:candidate,verified:true});
   await write(key,key==='volume'?0:value);
  }
  if(report.tests.length%25===0)console.log(`Verified ${report.tests.length} control writes; ${key}`);
 }
 report.verified=true;
} catch(error) {report.error=error.message;process.exitCode=1;}
finally {
 if(wrote) {
  console.log('Restoring original settings…');
  try {
   const entries=Object.entries(original).filter(([key])=>key!=='volume');
   const order=([key])=>key.endsWith('Enabled')?4:go2.parameters[key].values?1:3;
   entries.sort((a,b)=>order(a)-order(b));
   for(const [key,value] of entries)await write(key,value);
   await write('volume',original.volume);
   const after=await driver.snapshot();
   const differences=Object.keys(original).filter(key=>driver.reader.allSettings[key]!==original[key]);
   report.restored=differences.length===0;
   report.restoreDifferences=differences;
   report.after=after;
   if(!report.restored)process.exitCode=1;
  }catch(error){report.restoreError=error.message;process.exitCode=1;}
 }
 await driver.close();
 await writeFile(new URL(`controls-report${suffix}.json`,root),JSON.stringify(report,null,2));
 console.log(JSON.stringify({tests:report.tests.length,verified:report.verified,restored:report.restored,error:report.error,restoreError:report.restoreError,differences:report.restoreDifferences}));
}
