/**
 * Pure utility functions for TottiLooper.
 *
 * All functions here are free of DOM and global state — they receive every
 * dependency they need as explicit parameters, making them straightforward to
 * unit-test without a browser environment.
 */

'use strict';

const MIDI_TICKS_PER_BEAT = 480;
const MIDI_CLICK_NOTE_LENGTH = 60;
const MIDI_DOWNBEAT_NOTE = 76;
const MIDI_OFFBEAT_NOTE = 77;
const MIDI_DOWNBEAT_VELOCITY = 110;
const MIDI_OFFBEAT_VELOCITY = 84;

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format a duration in seconds as "M:SS".
 * @param {number} secs
 * @returns {string}
 */
export function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format a pan value (-1…1) as a human-readable label: "C", "L50", "R75", etc.
 * @param {number} v
 * @returns {string}
 */
export function panText(v) {
  if (Math.abs(v) < 0.02) return 'C';
  return (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
}

// ─── MIME type detection ──────────────────────────────────────────────────────

/**
 * Return the first audio MIME type supported by MediaRecorder, or ''.
 * @returns {string}
 */
export function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ─── Gain / mix logic ─────────────────────────────────────────────────────────

/**
 * Compute the effective output gain for a loop, accounting for mute, solo, and
 * per-loop volume.
 *
 * @param {{ muted: boolean, soloed: boolean, volume: number }} loop
 * @param {Array<{ soloed: boolean }>} loops - the complete list of loops
 * @returns {number}
 */
export function effectiveGain(loop, loops) {
  if (loop.muted) return 0;
  const anySolo = loops.some(l => l.soloed);
  if (anySolo && !loop.soloed) return 0;
  return loop.volume;
}

// ─── AudioBuffer utilities ────────────────────────────────────────────────────

/**
 * Snap a recorded AudioBuffer's length to a whole number of bars.
 *
 * @param {AudioBuffer} buffer
 * @param {{ bpm: number, beatsPerBar: number, audioContext: AudioContext }} opts
 * @returns {AudioBuffer}
 */
export function quantizeBuffer(buffer, { bpm, beatsPerBar, audioContext }) {
  const beatSeconds = 60 / bpm;
  const barSeconds  = beatSeconds * beatsPerBar;
  const numBars     = Math.max(1, Math.round(buffer.duration / barSeconds));
  const targetDur   = numBars * barSeconds;
  const targetLen   = Math.round(targetDur * buffer.sampleRate);

  const out = audioContext.createBuffer(
    buffer.numberOfChannels,
    targetLen,
    buffer.sampleRate,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, Math.min(src.length, targetLen)));
    // Any extra samples beyond src.length remain 0 (silence tail).
  }
  return out;
}

/**
 * Shift an AudioBuffer earlier or later without changing its total length.
 * Positive offsets add silence at the start; negative offsets trim the start.
 * This is intended for corrective alignment, so callers can negate user-facing
 * compensation values as needed before invoking it.
 *
 * @param {AudioBuffer} buffer
 * @param {number} offsetSeconds
 * @param {AudioContext} audioContext
 * @returns {AudioBuffer}
 */
export function offsetBuffer(buffer, offsetSeconds, audioContext) {
  const sampleOffset = Math.round(offsetSeconds * buffer.sampleRate);
  if (sampleOffset === 0) return buffer;

  const out = audioContext.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  );

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);

    if (sampleOffset > 0) {
      if (sampleOffset >= dst.length) continue;
      const copyLen = Math.max(0, src.length - sampleOffset);
      dst.set(src.subarray(0, copyLen), sampleOffset);
    } else {
      const start = Math.min(src.length, Math.abs(sampleOffset));
      dst.set(src.subarray(start), 0);
    }
  }

  return out;
}

/**
 * Return a new AudioBuffer with all channel data reversed.
 *
 * @param {AudioBuffer} buffer
 * @param {AudioContext} audioContext
 * @returns {AudioBuffer}
 */
export function reverseBuffer(buffer, audioContext) {
  const rev = audioContext.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = rev.getChannelData(ch);
    for (let i = 0, n = src.length; i < n; i++) {
      dst[i] = src[n - 1 - i];
    }
  }
  return rev;
}

// ─── MIDI encoding ────────────────────────────────────────────────────────────

/**
 * Encode the current session tempo as a simple MIDI click track.
 *
 * @param {{ bpm: number, beatsPerBar: number, durationSeconds: number }} opts
 * @returns {Blob}
 */
export function clickTrackToMidi({ bpm, beatsPerBar, durationSeconds }) {
  const totalTicks = Math.max(1, Math.ceil((durationSeconds * bpm * MIDI_TICKS_PER_BEAT) / 60));
  const beatCount = Math.floor((totalTicks - 1) / MIDI_TICKS_PER_BEAT) + 1;
  const noteLength = Math.min(MIDI_CLICK_NOTE_LENGTH, MIDI_TICKS_PER_BEAT);
  const tempoMicros = Math.round(60000000 / bpm);
  const track = [];

  appendMetaEvent(track, 0, 0x03, textBytes('Click Track'));
  appendMetaEvent(track, 0, 0x51, [
    (tempoMicros >> 16) & 0xff,
    (tempoMicros >> 8) & 0xff,
    tempoMicros & 0xff,
  ]);
  appendMetaEvent(track, 0, 0x58, [beatsPerBar, 2, 24, 8]);

  let lastTick = 0;
  for (let beat = 0; beat < beatCount; beat++) {
    const startTick = beat * MIDI_TICKS_PER_BEAT;
    const note = beat % beatsPerBar === 0 ? MIDI_DOWNBEAT_NOTE : MIDI_OFFBEAT_NOTE;
    const velocity = beat % beatsPerBar === 0 ? MIDI_DOWNBEAT_VELOCITY : MIDI_OFFBEAT_VELOCITY;
    appendMidiEvent(track, startTick - lastTick, [0x99, note, velocity]);
    lastTick = startTick;

    const endTick = Math.min(startTick + noteLength, totalTicks);
    appendMidiEvent(track, endTick - lastTick, [0x89, note, 0]);
    lastTick = endTick;
  }

  appendMetaEvent(track, totalTicks - lastTick, 0x2f, []);

  const bytes = [
    ...textBytes('MThd'),
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (MIDI_TICKS_PER_BEAT >> 8) & 0xff, MIDI_TICKS_PER_BEAT & 0xff,
    ...textBytes('MTrk'),
    (track.length >>> 24) & 0xff,
    (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff,
    track.length & 0xff,
    ...track,
  ];

  return new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
}

// ─── WAV encoding ─────────────────────────────────────────────────────────────

/**
 * Write an ASCII string into a DataView at the given byte offset.
 *
 * @param {DataView} view
 * @param {number} offset
 * @param {string} str
 */
export function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Encode an AudioBuffer as a 16-bit PCM WAV Blob.
 *
 * @param {AudioBuffer} buffer
 * @returns {Blob}
 */
export function audioBufferToWav(buffer) {
  const numCh      = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames  = buffer.length;
  const blockAlign = numCh * 2;
  const byteRate   = sampleRate * blockAlign;
  const dataSize   = numFrames * blockAlign;
  const ab   = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function appendMetaEvent(track, delta, type, data) {
  appendMidiEvent(track, delta, [0xff, type, data.length, ...data]);
}

function appendMidiEvent(track, delta, bytes) {
  track.push(...encodeVarLen(delta), ...bytes);
}

function encodeVarLen(value) {
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= 0x80 | (value & 0x7f);
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else return bytes;
  }
}

function textBytes(text) {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}
