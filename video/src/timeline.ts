import voiceover from "./voiceover.json";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// Frames of picture before a scene's narration starts and after it ends.
export const LEAD = 9;
const TAIL = 15;
// Frames each scene overlaps the next, for the cross-fade.
export const OVERLAP = 14;
const EXTRA: Record<string, number> = { hook: 8, ai: 6, outro: 66 };

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Scene {
  id: string;
  start: number;
  length: number;
  voice: string;
  voiceFrames: number;
  words: Word[];
}

export const scenes: Scene[] = [];
let cursor = 0;
for (const line of voiceover.lines) {
  const voiceFrames = Math.ceil(line.seconds * FPS);
  const length = LEAD + voiceFrames + TAIL + (EXTRA[line.id] ?? 0);
  scenes.push({ id: line.id, start: cursor, length, voice: line.file, voiceFrames, words: line.words });
  cursor += length - OVERLAP;
}
export const DURATION = cursor + OVERLAP;

export function scene(id: string): Scene {
  const found = scenes.find((s) => s.id === id);
  if (!found) throw new Error(`No scene "${id}"`);
  return found;
}

/** Frame, counted from the scene's start, at which the narration says `word` (its `nth` occurrence). */
export function cue(id: string, word: string, nth = 0): number {
  const hits = scene(id).words.filter((w) => w.text.toLowerCase() === word.toLowerCase());
  const hit = hits[nth];
  if (!hit) throw new Error(`Scene "${id}" never says "${word}" (#${nth})`);
  return LEAD + Math.round(hit.start * FPS);
}

/** Whether any narration is playing at an absolute frame. */
export function speaking(frame: number): boolean {
  return scenes.some((s) => frame >= s.start + LEAD && frame < s.start + LEAD + s.voiceFrames);
}
