/**
 * Pure utility functions for TottiLooper.
 *
 * All functions here are free of DOM and global state — they receive every
 * dependency they need as explicit parameters, making them straightforward to
 * unit-test without a browser environment.
 */

'use strict';

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

// ─── BPM / timing math ────────────────────────────────────────────────────────

/**
 * Return the duration of one beat in seconds.
 *
 * @param {number} bpm  Beats per minute (must be > 0).
 * @returns {number}
 */
export function getBeatSeconds(bpm) {
  return 60 / bpm;
}

/**
 * Return the duration of one bar in seconds.
 *
 * @param {number} bpm
 * @param {number} beatsPerBar
 * @returns {number}
 */
export function getBarSeconds(bpm, beatsPerBar) {
  return getBeatSeconds(bpm) * beatsPerBar;
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

/**
 * Return a new AudioBuffer with a linear fade-in applied to the first
 * `fadeSamples` samples of every channel.  Samples beyond `fadeSamples` are
 * copied unchanged.  When `fadeSamples` is 0 or exceeds the buffer length the
 * buffer is returned unmodified.
 *
 * @param {AudioBuffer} buffer
 * @param {number} fadeSamples  Number of samples over which to ramp from 0→1.
 * @param {AudioContext} audioContext
 * @returns {AudioBuffer}
 */
export function applyFadeIn(buffer, fadeSamples, audioContext) {
  const len = buffer.length;
  const ramp = Math.min(fadeSamples, len);
  if (ramp <= 0) return buffer;

  const out = audioContext.createBuffer(
    buffer.numberOfChannels,
    len,
    buffer.sampleRate,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < ramp; i++) {
      dst[i] = src[i] * (i / ramp);
    }
    dst.set(src.subarray(ramp), ramp);
  }
  return out;
}

/**
 * Return a new AudioBuffer with a linear fade-out applied to the last
 * `fadeSamples` samples of every channel.  Samples before the fade region are
 * copied unchanged.  When `fadeSamples` is 0 or exceeds the buffer length the
 * buffer is returned unmodified.
 *
 * @param {AudioBuffer} buffer
 * @param {number} fadeSamples  Number of samples over which to ramp from 1→0.
 * @param {AudioContext} audioContext
 * @returns {AudioBuffer}
 */
export function applyFadeOut(buffer, fadeSamples, audioContext) {
  const len = buffer.length;
  const ramp = Math.min(fadeSamples, len);
  if (ramp <= 0) return buffer;

  const fadeStart = len - ramp;
  const out = audioContext.createBuffer(
    buffer.numberOfChannels,
    len,
    buffer.sampleRate,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, fadeStart), 0);
    for (let i = 0; i < ramp; i++) {
      dst[fadeStart + i] = src[fadeStart + i] * (1 - i / ramp);
    }
  }
  return out;
}

// ─── Undo stack ───────────────────────────────────────────────────────────────

/**
 * A bounded LIFO undo stack.  When `maxSize` is exceeded the oldest item is
 * automatically discarded from the bottom of the stack.
 *
 * This is a pure-JS data structure with no dependency on the DOM or the Web
 * Audio API, making it straightforward to unit-test in Node.
 */
export class UndoStack {
  /**
   * @param {number} maxSize  Maximum number of items to keep (must be ≥ 1).
   */
  constructor(maxSize) {
    this._maxSize = Math.max(1, maxSize);
    this._items = [];
  }

  /** Number of items currently in the stack. */
  get size() { return this._items.length; }

  /** True when there is at least one item available to pop. */
  get canUndo() { return this._items.length > 0; }

  /**
   * Push an item onto the stack.  If the stack is already at capacity the
   * oldest item is removed before the new one is added.
   * @param {*} item
   */
  push(item) {
    this._items.push(item);
    if (this._items.length > this._maxSize) {
      this._items.shift();
    }
  }

  /**
   * Remove and return the most recently pushed item, or `null` if empty.
   * @returns {*}
   */
  pop() {
    return this._items.pop() ?? null;
  }

  /** Remove all items from the stack. */
  clear() {
    this._items = [];
  }
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
