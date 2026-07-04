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
 * Clone an AudioBuffer into a fresh buffer owned by the provided AudioContext.
 *
 * @param {AudioBuffer} buffer
 * @param {AudioContext} audioContext
 * @returns {AudioBuffer}
 */
export function cloneBuffer(buffer, audioContext) {
  const out = audioContext.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buffer.getChannelData(ch));
  }
  return out;
}

/**
 * Return a new AudioBuffer resampled by the given ratio.
 *
 * ratio > 1 raises pitch and shortens the buffer; ratio < 1 lowers pitch and
 * lengthens it.
 *
 * @param {AudioBuffer} buffer
 * @param {number} ratio
 * @param {AudioContext} audioContext
 * @returns {AudioBuffer}
 */
export function resampleBuffer(buffer, ratio, audioContext) {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error('Resample ratio must be a positive number.');
  }
  if (Math.abs(ratio - 1) < 1e-6) return cloneBuffer(buffer, audioContext);

  const outLen = Math.max(1, Math.round(buffer.length / ratio));
  const out = audioContext.createBuffer(
    buffer.numberOfChannels,
    outLen,
    buffer.sampleRate,
  );

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const lo = Math.floor(pos);
      const hi = Math.min(src.length - 1, lo + 1);
      const frac = pos - lo;
      const a = src[Math.min(src.length - 1, lo)];
      const b = src[hi];
      dst[i] = a + (b - a) * frac;
    }
  }

  return out;
}

/**
 * Time-stretch an AudioBuffer using a simple granular overlap-add process.
 *
 * factor > 1 lengthens the buffer while roughly preserving pitch; factor < 1
 * shortens it while roughly preserving pitch.
 *
 * @param {AudioBuffer} buffer
 * @param {number} factor
 * @param {AudioContext} audioContext
 * @returns {AudioBuffer}
 */
export function timeStretchBuffer(buffer, factor, audioContext) {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error('Stretch factor must be a positive number.');
  }
  if (Math.abs(factor - 1) < 1e-6) return cloneBuffer(buffer, audioContext);
  if (buffer.length < 32) {
    return resampleBuffer(buffer, 1 / factor, audioContext);
  }

  const outLen = Math.max(1, Math.round(buffer.length * factor));
  const out = audioContext.createBuffer(
    buffer.numberOfChannels,
    outLen,
    buffer.sampleRate,
  );

  const grainSize = Math.max(32, Math.min(2048, buffer.length));
  const analysisHop = Math.max(16, Math.min(Math.floor(grainSize / 8), grainSize));
  const synthesisHop = Math.max(8, Math.round(analysisHop * factor));
  const window = new Float32Array(grainSize);
  const normalizer = new Float32Array(outLen);

  for (let i = 0; i < grainSize; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grainSize - 1 || 1));
  }

  for (let inPos = 0, outPos = 0; outPos < outLen; inPos += analysisHop, outPos += synthesisHop) {
    const sourceStart = Math.min(Math.max(0, inPos), Math.max(0, buffer.length - grainSize));

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = out.getChannelData(ch);

      for (let i = 0; i < grainSize; i++) {
        const dstIndex = outPos + i;
        if (dstIndex >= outLen) break;
        const weight = window[i];
        dst[dstIndex] += src[sourceStart + i] * weight;
        if (ch === 0) normalizer[dstIndex] += weight;
      }
    }
  }

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const dst = out.getChannelData(ch);
    for (let i = 0; i < outLen; i++) {
      const weight = normalizer[i];
      if (weight > 1e-6) dst[i] /= weight;
    }
  }

  return out;
}

/**
 * Transform a loop buffer so speed and pitch can be controlled independently.
 *
 * @param {AudioBuffer} buffer
 * @param {{ speed: number, pitchSemitones: number, audioContext: AudioContext }} opts
 * @returns {AudioBuffer}
 */
export function transformBuffer(buffer, { speed, pitchSemitones, audioContext }) {
  const pitchRatio = 2 ** (pitchSemitones / 12);
  const pitched = Math.abs(pitchRatio - 1) < 1e-6
    ? cloneBuffer(buffer, audioContext)
    : resampleBuffer(buffer, pitchRatio, audioContext);
  const stretchFactor = pitchRatio / speed;
  return Math.abs(stretchFactor - 1) < 1e-6
    ? pitched
    : timeStretchBuffer(pitched, stretchFactor, audioContext);
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
