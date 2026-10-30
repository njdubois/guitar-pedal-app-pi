import { choices, lowCut, highCut, eqFrequency, eqQ, frequencies } from './go-tone.js';
// Independently written GO guitar protocol map. Sources and verification limits:
// docs/go2-protocol-notes.md. GO enum IDs differ from the MkII IDs.
const enumValues = names => Object.fromEntries(names.map((name, index) => [name, index]));
export const goEffectTypes = {
  booster: enumValues(['clean-boost', 'treble-boost', 'mid-boost', 'crunch-od', 'blues-drive',
    'overdrive', 'natural-od', 'warm-od', 'turbo-od', 't-scream', 'distortion', 'fat-ds',
    'dst-plus', 'guv-ds', 'rat', 'metal-zone', 'metal-ds', '60s-fuzz', 'muff-fuzz',
    'oct-fuzz', 'hm-2', 'metal-core', 'centa-od']),
  mod: enumValues(['chorus', 'flanger', 'phaser', 'uni-v', 'tremolo', 'vibrato', 'rotary',
    'ring-mod', 'slow-gear', 'slicer', 'comp', 'limiter', 't-wah', 'auto-wah', 'graphic-eq',
    'parametric-eq', 'guitar-sim', 'ac-guitar-sim', 'ac-processor', 'wave-synth', 'octave',
    'heavy-octave', 'pitch-shifter', 'harmonist', 'humanizer', 'phaser-90e', 'flanger-117e', 'dc-30']),
  delay: enumValues(['digital', 'pan', 'stereo', 'analog', 'tape-echo', 'reverse', 'modulate', 'sde-3000']),
  reverb: enumValues(['plate', 'room', 'hall', 'spring', 'modulate']),
};
goEffectTypes.fx = goEffectTypes.mod;
goEffectTypes.delay2 = goEffectTypes.delay;

const parameter = (address, group, extra = {}) => ({ address, group, min: 0, max: 100, offset: 0, ...extra });
const at = (page, block, offset) => [0x20, page, block, offset];
const timing = { size: 4, radix: 16, unit: 'ms' };
export const goEffectParameters = {};
for (const [group, block] of [['booster', 0x40], ['mod', 0x60], ['fx', 0x70]]) {
  goEffectParameters[`${group}Type`] = parameter(at(0, block, 0), group, { values: goEffectTypes[group], order: 1 });
}
for (const [name, offset, extra] of [
  ['Drive', 1, { max: 120 }], ['Bottom', 2, { min: -50, max: 50, offset: 50 }],
  ['Tone', 3, { min: -50, max: 50, offset: 50 }], ['Level', 6, {}], ['DirectMix', 7, {}],
]) goEffectParameters[`booster${name}`] = parameter(at(0, 0x40, offset), 'booster', extra);

for (const [group, block] of [['delay', 0x20], ['delay2', 0x30]]) {
  for (const [name, offset, extra] of [
    ['Type', 0, { values: goEffectTypes[group], order: 1 }],
    ['TimeMs', 1, { ...timing, min: 1, max: 2000 }], ['Feedback', 5, {}],
    ['Level', 7, { max: 120 }], ['DirectMix', 8, {}],
  ]) goEffectParameters[`${group}${name}`] = parameter(at(1, block, offset), group, extra);
}
for (const [name, offset, extra] of [
  ['Type', 0, { values: goEffectTypes.reverb, order: 1 }],
  ['TimeMs', 2, { min: 100, max: 10000, scale: 100, offset: -1, step: 100, unit: 'ms' }],
  ['PreDelayMs', 3, { ...timing, max: 500 }], ['Density', 9, { max: 10 }],
  ['Level', 10, {}], ['DirectMix', 11, {}], ['SpringColor', 12, {}],
]) goEffectParameters[`reverb${name}`] = parameter(at(1, 0x40, offset), 'reverb', extra);

for (const [name, offset, extra] of [['SoloEnabled',4,{boolean:true,order:4,offOrder:0}],['SoloLevel',5,{}]]) {
  goEffectParameters[`booster${name}`] = parameter(at(0,0x40,offset),'booster',{extension:true,...extra});
}
for (const [group,bank] of [['delay',0x20],['delay2',0x30]]) {
  for (const [name,offset,extra] of [
    ['HighCut',6,{values:highCut}],['TapTime',9,{min:0,max:100,unit:'%'}],['ModRate',10,{}],['ModDepth',11,{}],
    ['LowPassFilter',12,{boolean:true}],['Filter',13,{values:choices(['8 kHz','17 kHz'])}],
    ['FeedbackPhase',14,{values:choices(['normal','inverted'])}],['EffectPhase',15,{values:choices(['normal','inverted'])}],
    ['ModEnabled',16,{boolean:true}],
  ]) goEffectParameters[`${group}${name}`] = parameter(at(1,bank,offset),group,{extension:true,...extra});
}
for (const [name,offset,extra] of [['LowCut',7,{values:lowCut}],['HighCut',8,{values:highCut}]]) {
  goEffectParameters[`reverb${name}`] = parameter(at(1,0x40,offset),'reverb',{extension:true,...extra});
}

// Algorithm settings have separate storage: a chorus rate is not a compressor
// sustain value. The UI/validator expose only the selected algorithm's fields.
// Filters, selectors and user harmony scales are included below. No
// fictitious assigned-knob address is used.
const signedTone = { min: -50, max: 50, offset: 50 };
const eqGain = { min: -20, max: 20, offset: 20, unit: 'dB' };
const recipes = {
  chorus: [['LowRate', 1], ['LowDepth', 2], ['LowLevel', 4], ['HighRate', 5], ['HighDepth', 6], ['HighLevel', 8], ['DirectMix', 9]],
  flanger: [['Rate', 10], ['Depth', 11], ['Manual', 12], ['Resonance', 13], ['Level', 15], ['DirectMix', 16]],
  phaser: [['Rate', 18], ['Depth', 19], ['Manual', 20], ['Resonance', 21], ['Level', 23], ['DirectMix', 24]],
  'uni-v': [['Rate', 25], ['Depth', 26], ['Level', 27]],
  tremolo: [['WaveShape', 28], ['Rate', 29], ['Depth', 30], ['Level', 31]],
  vibrato: [['Rate', 32], ['Depth', 33], ['Level', 34]],
  rotary: [['Rate', 35], ['Depth', 36], ['Level', 37]],
  'ring-mod': [['Frequency', 39], ['Level', 40], ['DirectMix', 41]],
  'slow-gear': [['Sensitivity', 42], ['RiseTime', 43], ['Level', 44]],
  slicer: [['Pattern', 45, { min: 1, max: 20, offset: -1 }], ['Rate', 46], ['TriggerSensitivity', 47], ['Level', 48], ['DirectMix', 49]],
  comp: [['Sustain', 51], ['Attack', 52], ['Tone', 53, signedTone], ['Level', 54]],
  limiter: [['Attack', 56], ['Threshold', 57], ['Release', 59], ['Level', 60]],
  't-wah': [['Sensitivity', 63], ['Frequency', 64], ['Peak', 65], ['DirectMix', 66], ['Level', 67]],
  'auto-wah': [['Frequency', 69], ['Peak', 70], ['Rate', 71], ['Depth', 72], ['DirectMix', 73], ['Level', 74]],
  'graphic-eq': [...['31Hz', '62Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz', '8kHz', '16kHz', 'Level'].map((name, i) => [name, 75 + i, eqGain])],
  'parametric-eq': [['LowGain', 87, eqGain], ['LowMidGain', 90, eqGain], ['HighMidGain', 93, eqGain], ['HighGain', 94, eqGain], ['Level', 96, eqGain]],
  'guitar-sim': [['Low', 98, signedTone], ['High', 99, signedTone], ['Level', 100], ['Body', 101]],
  'ac-guitar-sim': [['High', 102, signedTone], ['Body', 103], ['Low', 104, signedTone], ['Level', 105]],
  'ac-processor': [['Bass', 107, signedTone], ['Middle', 108, signedTone], ['Treble', 110, signedTone], ['Presence', 111, signedTone], ['Level', 112]],
  'wave-synth': [['CutoffFrequency', 114], ['Resonance', 115], ['FilterSensitivity', 116], ['FilterDecay', 117], ['FilterDepth', 118], ['Level', 119], ['DirectMix', 120]],
  octave: [['Level', 122], ['DirectMix', 123]],
  'heavy-octave': [['Octave1Level', 124], ['Octave2Level', 125], ['DirectMix', 126]],
  'pitch-shifter': [['Voice1Pitch', 129, { min: -24, max: 24, offset: 24, unit: 'semitones' }],
    ['Voice1Fine', 130, signedTone], ['Voice1PreDelayMs', 131, { ...timing, max: 300 }], ['Voice1Level', 135],
    ['Voice2Pitch', 137, { min: -24, max: 24, offset: 24, unit: 'semitones' }],
    ['Voice2Fine', 138, signedTone], ['Voice2PreDelayMs', 139, { ...timing, max: 300 }], ['Voice2Level', 143],
    ['Feedback', 144], ['DirectMix', 145]],
  harmonist: [['Voice1PreDelayMs', 148, { ...timing, max: 300 }], ['Voice1Level', 152],
    ['Voice2PreDelayMs', 154, { ...timing, max: 300 }], ['Voice2Level', 158], ['Feedback', 159], ['DirectMix', 160]],
  humanizer: [['Sensitivity', 188], ['Rate', 189], ['Depth', 190], ['Manual', 191], ['Level', 192]],
  'phaser-90e': [['Script', 193, { boolean: true }], ['Speed', 194]],
  'flanger-117e': [['Manual', 195], ['Width', 196], ['Speed', 197], ['Regeneration', 198]],
  'dc-30': [['Mode', 199, { values: enumValues(['chorus', 'echo']) }], ['InputLevel', 200],
    ['ChorusIntensity', 201], ['EchoTimeMs', 202, { ...timing, min: 40, max: 600 }],
    ['EchoIntensity', 206], ['EchoLevel', 207], ['Tone', 208]],
};
// Complete guitar algorithm controls, including selectors and user scales.
const extraFields = {
  chorus: [['CrossoverFrequency',0,{values:choices(frequencies.slice(7,24))}], ['LowPreDelayMs',3,{max:40,scale:0.5,unit:'ms'}], ['HighPreDelayMs',7,{max:40,scale:0.5,unit:'ms'}]],
  flanger: [['LowCut',14,{values:choices(['Flat','55 Hz','110 Hz','165 Hz','200 Hz','280 Hz','340 Hz','400 Hz','500 Hz','630 Hz','800 Hz'])}]],
  phaser: [['Stage',17,{values:choices(['4-stage','8-stage','12-stage','bi-phase'])}],['StepRate',22]],
  'ring-mod': [['Mode',38,{values:choices(['normal','intelligent'])}]],
  comp: [['Model',50,{values:choices(['boss','hi-band','light','d-comp','orange','fat','mild'])}]],
  limiter: [['Model',55,{values:choices(['boss','rack-160d','vtg-rack-u'])}],['Ratio',58,{values:choices(['1:1','1.2:1','1.4:1','1.6:1','1.8:1','2:1','2.3:1','2.6:1','3:1','3.5:1','4:1','5:1','6:1','8:1','10:1','12:1','20:1','infinity:1'])}]],
  't-wah': [['Mode',61,{values:choices(['low-pass','band-pass'])}],['Polarity',62,{values:choices(['down','up'])}]],
  'auto-wah': [['Mode',68,{values:choices(['low-pass','band-pass'])}]],
  'parametric-eq': [['LowCut',86,{values:lowCut}],['LowMidFrequency',88,{values:eqFrequency}],['LowMidQ',89,{values:eqQ}],['HighMidFrequency',91,{values:eqFrequency}],['HighMidQ',92,{values:eqQ}],['HighCut',95,{values:highCut}]],
  'guitar-sim': [['Model',97,{values:choices(['single-to-humbucker','humbucker-to-single','humbucker-to-half-tone','single-to-hollow','humbucker-to-hollow','single-to-acoustic','humbucker-to-acoustic','piezo-to-acoustic'])}]],
  'ac-processor': [['Model',106,{values:choices(['small','medium','bright','power'])}],['MidFrequency',109,{values:eqFrequency}]],
  'wave-synth': [['Waveform',113,{values:choices(['saw','square'])}]],
  octave: [['Range',121,{values:choices(['1','2','3','4'])}]],
  'pitch-shifter': [['Voices',127,{values:choices(['1','2'])}],['Voice1Mode',128,{values:choices(['fast','medium','slow','mono'])}],['Voice2Mode',136,{values:choices(['fast','medium','slow','mono'])}]],
  harmonist: [['Voices',146,{values:choices(['1','2'])}],
    ...[147,153].map((offset,i)=>[`Voice${i+1}Harmony`,offset,{values:choices(['-2 oct','-14th','-13th','-12th','-11th','-10th','-9th','-8th','-7th','-6th','-5th','-4th','-3rd','-2nd','unison','+2nd','+3rd','+4th','+5th','+6th','+7th','+8th','+9th','+10th','+11th','+12th','+13th','+14th','+2 oct','user'])}]),
    ...[1,2].flatMap(voice=>['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'].map((note,i)=>[`Voice${voice}User${note}`,161+(voice-1)*12+i,{min:-24,max:24,offset:24,unit:'semitones'}])),
  ],
  humanizer: [['Mode',185,{values:choices(['picking','auto'])}],['Vowel1',186,{values:choices(['a','e','i','o','u'])}],['Vowel2',187,{values:choices(['a','e','i','o','u'])}]],
  'dc-30': [['Output',209,{values:choices(['D+E','D/E'])}]],
};
// The old map had Guitar Sim's body/level addresses interchanged.
recipes['guitar-sim'] = recipes['guitar-sim'].map(([name,offset,p])=>[name,name==='Body'?100:name==='Level'?101:offset,p]);
// T-Wah and Auto-Wah store effect level before direct level.
for (const [algorithm,level,direct] of [['t-wah',66,67],['auto-wah',73,74]]) {
  recipes[algorithm] = recipes[algorithm].map(([name,offset,p])=>[name,name==='Level'?level:name==='DirectMix'?direct:offset,p]);
}
for (const [algorithm,fields] of Object.entries(extraFields)) recipes[algorithm].push(...fields.map(([name,offset,p])=>[name,offset,{...p,extension:true}]));
export const goAlgorithmFields = { mod: {}, fx: {} };
for (const group of ['mod', 'fx']) {
  for (const [algorithm, fields] of Object.entries(recipes)) {
    const prefix = algorithm.replace(/(^|-)([a-z])/g, (_, _dash, letter) => letter.toUpperCase());
    goAlgorithmFields[group][algorithm] = fields.map(([name, offset, extra]) => {
      const key = `${group}${prefix}${name}`;
      goEffectParameters[key] = parameter(at(1, (group === 'mod' ? 0 : 0x10) + Math.floor(offset / 128), offset % 128), group,
        { algorithm, label: `${group.toUpperCase()} ${algorithm.replaceAll('-', ' ')} ${name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace('Ms', '(ms)')}`, ...extra });
      return key;
    });
  }
}

export const goEffectReadBlocks = [
  { group: 'booster', address: at(0, 0x40, 0), size: 8 },
  { group: 'mod', address: at(0, 0x60, 0), size: 1 },
  { group: 'fx', address: at(0, 0x70, 0), size: 1 },
  { group: 'delay', address: at(1, 0x20, 0), size: 17 },
  { group: 'delay2', address: at(1, 0x30, 0), size: 17 },
  { group: 'reverb', address: at(1, 0x40, 0), size: 13 },
];
