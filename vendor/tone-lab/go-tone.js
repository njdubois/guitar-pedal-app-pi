// GO guitar tone controls. Independently expressed protocol facts; sources and
// hardware verification are documented in docs/go2-protocol-notes.md.
export const choices = names => Object.fromEntries(names.map((name, index) => [name, index]));
export const frequencies = ['20 Hz','25 Hz','31.5 Hz','40 Hz','50 Hz','63 Hz','80 Hz','100 Hz','125 Hz','160 Hz','200 Hz','250 Hz','315 Hz','400 Hz','500 Hz','630 Hz','800 Hz','1 kHz','1.25 kHz','1.6 kHz','2 kHz','2.5 kHz','3.15 kHz','4 kHz','5 kHz','6.3 kHz','8 kHz','10 kHz'];
export const lowCut = choices(['Flat', ...frequencies.slice(0,17)]);
export const highCut = choices([...frequencies.slice(15), '12.5 kHz','Flat']);
export const eqFrequency = choices(frequencies);
export const eqQ = choices(['0.5','1','2','4','8','16']);
const db = { min:-20, max:20, offset:20, unit:'dB' };
const soloDb = { min:-12, max:12, scale:0.5, offset:24, unit:'dB' };
const position = { values:choices(['amp-in','amp-out']) };
export const goToneParameters = {};
export const goToneReadBlocks = [];
function block(group, page, bank, size, fields) {
  goToneReadBlocks.push({group, address:[0x20,page,bank,0], size});
  for (const [name, offset, extra = {}] of fields) {
    goToneParameters[name] = {address:[0x20,page,bank,offset], group, min:0, max:100, offset:0, extension:true, ...extra};
  }
}
block('routing',0,0x10,3,[
  ['chain',0,{values:choices(['1','2-1','3-1','4-1','2-2','3-2','4-2'])}],
  ['cabinetResonance',1,{values:choices(['vintage','modern','deep'])}],
  ['masterKey',2,{values:choices(['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'])}],
]);
block('solo',1,0x50,2,[['soloEnabled',0,{boolean:true,order:4,offOrder:0}],['soloLevel',1]]);
block('solo',1,0x60,10,[
  ['soloEqPosition',0,position],['soloEqEnabled',1,{boolean:true,order:4,offOrder:0}],
  ['soloEqLowCut',2,{values:lowCut}],['soloEqLowGain',3,soloDb],
  ['soloEqMidFrequency',4,{values:eqFrequency}],['soloEqMidQ',5,{values:eqQ}],
  ['soloEqMidGain',6,soloDb],['soloEqHighGain',7,soloDb],
  ['soloEqHighCut',8,{values:highCut}],['soloEqLevel',9,soloDb],
]);
block('contour',2,0,1,[['contourSelect',0,{values:choices(['off','1','2','3'])}]]);
for (let i=1;i<=3;i++) block('contour',2,i*0x10,2,[
  [`contour${i}Type`,0,{values:choices(['1','2','3','4'])}],
  [`contour${i}FrequencyShift`,1,{min:-50,max:50,offset:50}],
]);
block('pedalFx',2,0x40,3,[
  ['pedalFxPosition',0,{values:choices(['input','post-amp'])}],
  ['pedalFxEnabled',1,{boolean:true,order:4,offOrder:0}],
  ['pedalFxType',2,{values:choices(['wah','pedal-bend','wah95']),order:1}],
]);
block('pedalFx',2,0x50,15,[
  ['pedalFxWahType',0,{values:choices(['cry-wah','vo-wah','fat-wah','light-wah','7-string-wah','reso-wah']),algorithm:'wah'}],
  ...[['Position',1],['Min',2],['Max',3],['Level',4],['DirectMix',5]].map(([name,offset])=>[`pedalFxWah${name}`,offset,{algorithm:'wah'}]),
  ['pedalFxBendPitch',6,{min:-24,max:24,offset:24,algorithm:'pedal-bend',unit:'semitones'}],
  ...[['Position',7],['Level',8],['DirectMix',9]].map(([name,offset])=>[`pedalFxBend${name}`,offset,{algorithm:'pedal-bend'}]),
  ...[['Position',10],['Min',11],['Max',12],['Level',13],['DirectMix',14]].map(([name,offset])=>[`pedalFxWah95${name}`,offset,{algorithm:'wah95'}]),
]);
for (let i=1;i<=2;i++) {
  const g=`eq${i}`;
  block(g,2,0x50+i*0x10,3,[
    [`${g}Position`,1,position],[`${g}Enabled`,0,{boolean:true,order:4,offOrder:0}],
    [`${g}Type`,2,{values:choices(['parametric','graphic']),order:1}],
  ]);
  block(g,3,(i-1)*0x10,11,[
    ['LowCut',0,{values:lowCut}],['LowGain',1,db],['LowMidFrequency',2,{values:eqFrequency}],
    ['LowMidQ',3,{values:eqQ}],['LowMidGain',4,db],['HighMidFrequency',5,{values:eqFrequency}],
    ['HighMidQ',6,{values:eqQ}],['HighMidGain',7,db],['HighGain',8,db],
    ['HighCut',9,{values:highCut}],['Level',10,db],
  ].map(([name,offset,p])=>[`${g}Parametric${name}`,offset,{...p,algorithm:'parametric'}]));
  block(g,3,0x20+(i-1)*0x10,11,
    ['31Hz','62Hz','125Hz','250Hz','500Hz','1kHz','2kHz','4kHz','8kHz','16kHz','Level'].map((name,offset)=>
      [`${g}Graphic${name}`,offset,{min:-12,max:12,scale:0.5,offset:24,unit:'dB',algorithm:'graphic'}]));
}
block('noiseGate',3,0x40,3,[
  ['noiseGateEnabled',0,{boolean:true,order:4,offOrder:0}],['noiseGateThreshold',1],['noiseGateRelease',2],
]);

// System settings are editable, but excluded from saved tone recall.
function system(group, bank, size, fields) {
  goToneReadBlocks.push({group,address:[0x10,0,bank,0],size});
  for (const [name,offset,extra={}] of fields) goToneParameters[name] = {
    address:[0x10,0,bank,offset],group,min:0,max:100,offset:0,extension:true,scope:'system',...extra,
  };
}
system('globalEq',0x10,1,[['globalEqEnabled',0,{boolean:true}]]);
system('globalEq',0x20,11,[
  ['LowCut',0,{values:lowCut}],['LowGain',1,db],['LowMidFrequency',2,{values:eqFrequency}],['LowMidQ',3,{values:eqQ}],
  ['LowMidGain',4,db],['HighMidFrequency',5,{values:eqFrequency}],['HighMidQ',6,{values:eqQ}],
  ['HighMidGain',7,db],['HighGain',8,db],['HighCut',9,{values:highCut}],['Level',10,db],
].map(([name,offset,p])=>[`globalEq${name}`,offset,p]));
system('stageFeel',0x30,1,[['stageFeelType',0,{values:choices(['off','1','2','custom'])}]]);
system('stageFeel',0x60,4,[
  ['stageFeelGuitarPosition',0,{min:-180,max:180,scale:3,step:3,offset:60,unit:'degrees'}],['stageFeelAudioPosition',1,{min:-180,max:180,scale:3,step:3,offset:60,unit:'degrees'}],
  ['stageFeelAmbienceType',2,{values:choices(['narrow','wide'])}],['stageFeelAmbienceLevel',3],
]);
system('usbAudio',0x70,3,[['usbInputLevel',0],['usbOutputLevel',1],['usbLoopback',2,{boolean:true}]]);
