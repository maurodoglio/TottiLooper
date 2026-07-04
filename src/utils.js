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
 * Create a one-bar loop from a built-in drum one-shot sample.
 *
 * @param {AudioContext} audioContext
 * @param {{ sample: 'kick' | 'snare' | 'clap', bpm: number, beatsPerBar: number }} opts
 * @returns {AudioBuffer}
 */
export function createBuiltinSampleLoop(audioContext, { sample, bpm, beatsPerBar }) {
  const sampleRate = audioContext.sampleRate;
  const beatSeconds = 60 / bpm;
  const duration = beatSeconds * beatsPerBar;
  const length = Math.max(1, Math.round(duration * sampleRate));
  const buffer = audioContext.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (const beat of builtinSamplePattern(sample, beatsPerBar)) {
    const offset = Math.round(beat * beatSeconds * sampleRate);
    renderBuiltinSample(data, offset, sampleRate, sample);
  }

  return buffer;
}

function builtinSamplePattern(sample, beatsPerBar) {
  switch (sample) {
    case 'kick': {
      const hits = [0];
      const midBeat = Math.floor(beatsPerBar / 2);
      if (midBeat > 0) hits.push(midBeat);
      return [...new Set(hits)].filter((beat) => beat < beatsPerBar);
    }
    case 'snare':
      return [1, 3].filter((beat) => beat < beatsPerBar);
    case 'clap': {
      const hits = [];
      for (let beat = 0.5; beat < beatsPerBar; beat += 1) hits.push(beat);
      return hits;
    }
    default:
      throw new Error(`Unknown built-in sample: ${sample}`);
  }
}

function renderBuiltinSample(data, offset, sampleRate, sample) {
  switch (sample) {
    case 'kick':
      renderKick(data, offset, sampleRate);
      return;
    case 'snare':
      renderSnare(data, offset, sampleRate);
      return;
    case 'clap':
      renderClap(data, offset, sampleRate);
      return;
    default:
      throw new Error(`Unknown built-in sample: ${sample}`);
  }
}

function renderKick(data, offset, sampleRate) {
  const duration = 0.35;
  const total = Math.min(data.length - offset, Math.round(duration * sampleRate));
  let phase = 0;

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const sweep = 1 - (i / total);
    const freq = 45 + (120 * sweep * sweep);
    phase += (2 * Math.PI * freq) / sampleRate;

    const body = Math.sin(phase) * Math.exp(-t * 10) * 0.95;
    const click = Math.exp(-t * 120) * 0.2;
    mixSample(data, offset + i, body + click);
  }
}

function renderSnare(data, offset, sampleRate) {
  const duration = 0.22;
  const total = Math.min(data.length - offset, Math.round(duration * sampleRate));
  let phase = 0;

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    phase += (2 * Math.PI * 180) / sampleRate;
    const noise = pseudoNoise(offset + i);
    const body = Math.sin(phase) * Math.exp(-t * 16) * 0.18;
    const snap = noise * Math.exp(-t * 24) * 0.7;
    mixSample(data, offset + i, body + snap);
  }
}

function renderClap(data, offset, sampleRate) {
  const duration = 0.18;
  const total = Math.min(data.length - offset, Math.round(duration * sampleRate));
  const bursts = [0, 0.02, 0.045];

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let envelope = 0;

    for (const burst of bursts) {
      const dt = t - burst;
      if (dt >= 0) envelope += Math.exp(-dt * 70);
    }

    const tail = Math.exp(-t * 18) * 0.35;
    const noise = pseudoNoise(offset + i);
    mixSample(data, offset + i, noise * ((envelope * 0.22) + tail));
  }
}

function mixSample(data, index, value) {
  if (index < 0 || index >= data.length) return;
  data[index] = Math.max(-1, Math.min(1, data[index] + value));
}

function pseudoNoise(seed) {
  const x = Math.sin((seed + 1) * 12.9898) * 43758.5453;
  return ((x - Math.floor(x)) * 2) - 1;
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
