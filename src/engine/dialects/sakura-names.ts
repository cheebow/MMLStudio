// Name constants usable in Sakura MML (SPEC 4.5.12): GM voice names (1-128), GS drum set names and
// GM drum note names. The numbers are the GM / GS standard; the spellings are the ones Sakura users write
// (e.g. `@(PickBass)`, `音色BrightPiano`, `n(Kick2)`, `Voice(StandardSet)`), including their historical typos.

/** GM program 1..128 in order */
const VOICES = [
  'GrandPiano', 'BrightPiano', 'ElectricGrandPiano', 'HonkyTonkPiano', 'ElectricPiano1', 'ElectricPiano2', 'Harpsichord', 'Clavi',
  'CelestaStrings', 'Glockenspiel', 'MusicBox', 'Vibraphone', 'Marimba', 'Xylophone', 'TubularBells', 'Dulcimer',
  'DrawbarOrgan', 'PercussiveOrgan', 'RockOrgan', 'ChurchOrgan', 'ReedOrgan', 'Accordion', 'Hamonica', 'TangoAccordion',
  'NylonGuitar', 'SteelcGuitar', 'JazzGuitar', 'CleanGuitar', 'MutedGuitar', 'OverdrivenGuitar', 'DistortionGuitar', 'GuitarHarmonics',
  'AcousticBass', 'FingerBass', 'PickBass', 'FretlessBass', 'SlapBass1', 'SlapBass2', 'SynthBass1', 'SynthBass2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'TremoloStrings', 'PizzicatoStrings', 'OrchestralHarp', 'Timpani',
  'Strings1', 'Strings2', 'SynthStrings1', 'SynthStrings2', 'ChoirAahs', 'VoiceOohs', 'SynthVoice', 'OrchestraHit',
  'Trumpet', 'Trombone', 'Tuba', 'MutedTrumpet', 'FrenchHorn', 'BrassSection', 'SynthBrass1', 'SynthBrass2',
  'SopranoSax', 'AltoSax', 'TenorSax', 'BaritoneSax', 'Oboe', 'EnglishHorn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'PanFlute', 'BlownBottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'SquareLead', 'SawtoothLead', 'CalliopeLead', 'ChiffLead', 'CharangLead', 'VoiceLead', 'FifthsLead', 'BassLead',
  'NewAgePad', 'WarmPad', 'PolySynthPad', 'ChoirPad', 'BowedPad', 'MetallicPad', 'HaloPad', 'SweepPad',
  'Rain', 'SoundTrack', 'Crystal', 'Atmosphere', 'Brightness', 'Goblins', 'Echoes', 'Sci_Fi',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'TinkleBell', 'Agogo', 'SteelDrums', 'Woodblock', 'TaikoDrum', 'MelodicTom', 'SynthDrum', 'ReverseCymbal',
  'FretNoise', 'BreathNoise', 'Seashore', 'BirdTweet', 'TelephoneRing', 'Helicopter', 'Applause', 'Gunshot',
];
const VOICE_ALIASES: Record<string, number> = { FingerBase: 34, TibkleBell: 113, Harmonica: 23, SteelGuitar: 26 };

/** GS drum sets (program numbers on the drum channel) */
const DRUM_SETS: Record<string, number> = {
  StandardSet: 1, StandardSet2: 2, RoomSet: 9, PowerSet: 17, ElectronicSet: 25, AnalogSet: 26, DanceSet: 27, JazzSet: 33,
  BrushSet: 41, OrchestraSet: 49,
};

/** GM drum note numbers 25..87 in order */
const DRUM_NOTES = [
  'SnareRoll', 'FingerSnap', 'HighQ', 'Slap', 'ScratchPush', 'ScratchPull', 'Sticks', 'SquareClick', 'MetronomeClick', 'MetronomeBell',
  'Kick2', 'Kick1', 'SideStick', 'Snare1', 'HandClap', 'Snare2', 'LowTom2', 'ClosedHiHat', 'LowTom1', 'PedalHiHat',
  'MidTom2', 'OpenHiHat', 'MidTom1', 'HighTom2', 'CrashCymbal1', 'HighTom1', 'RideCymbal1', 'ChineseCymbal', 'RideBell', 'Tambourine',
  'SplashCymbal', 'Cowbell', 'CrashCymbal2', 'VibraSlap', 'RideCymbal2', 'HighBongo', 'LowBongo', 'MuteHighConga', 'OpenHighConga', 'LowConga',
  'HighTimbale', 'LowTimbale', 'HighAgogo', 'LowAgogo', 'Cabasa', 'Maracas', 'ShortHiWhistle', 'LongLowWhistle', 'ShortGuiro', 'LongGuiro',
  'Claves', 'HighWoodBlock', 'LowWoodBlock', 'MuteCuica', 'OpenCuica', 'MuteTriangle', 'OpenTriangle', 'Shaker', 'JingleBell', 'BellTree',
  'Castanets', 'MuteSurdo', 'OpenSurdo',
];

const CONSTANTS = new Map<string, number>();
VOICES.forEach((n, i) => CONSTANTS.set(n, i + 1));
for (const [k, v] of Object.entries(VOICE_ALIASES)) CONSTANTS.set(k, v);
for (const [k, v] of Object.entries(DRUM_SETS)) CONSTANTS.set(k, v);
DRUM_NOTES.forEach((n, i) => CONSTANTS.set(n, i + 25));

const BY_LOWER = new Map([...CONSTANTS].map(([k, v]) => [k.toLowerCase(), v]));

/** A predefined name constant (case-sensitive first, then case-insensitive). */
export function sakuraConstant(name: string): number | undefined {
  return CONSTANTS.get(name) ?? BY_LOWER.get(name.toLowerCase());
}

/** `@(PickBass)` / `音色(Strings1)`: Sakura voice and drum set names -> 1..128 */
export function sakuraVoiceNumber(name: string): number | undefined {
  const key = name.replace(/\s+/g, '').toLowerCase();
  const i = VOICES.findIndex((v) => v.toLowerCase() === key);
  if (i >= 0) return i + 1;
  const alias = Object.entries({ ...VOICE_ALIASES, ...DRUM_SETS }).find(([k]) => k.toLowerCase() === key);
  return alias?.[1];
}
