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

// ─── Key detection ─────────────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SIGNATURES = [0, 7, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const MINOR_SIGNATURES = [-3, 4, -1, 6, 1, -4, 3, -2, 5, 0, 7, 2];

function detectFundamentalFrequency(samples, sampleRate, minFreq = 80, maxFreq = 1000) {
  const minLag = Math.max(1, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(samples.length - 1, Math.ceil(sampleRate / minFreq));
  let bestLag = -1;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let i = 0; i < samples.length - lag; i++) {
      correlation += samples[i] * samples[i + lag];
    }
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestCorrelation <= 0) return null;
  return sampleRate / bestLag;
}

function buildPitchClassHistogram(buffer) {
  if (!buffer || buffer.numberOfChannels === 0 || buffer.length === 0) {
    return {
      histogram: new Array(12).fill(0),
      samplesUsed: 0,
      firstPitchClass: null,
      lastPitchClass: null,
    };
  }

  const source = buffer.getChannelData(0);
  const windowSize = Math.min(4096, source.length);
  const hopSize = Math.max(1024, Math.floor(windowSize / 2));
  const histogram = new Array(12).fill(0);
  let samplesUsed = 0;
  let firstPitchClass = null;
  let lastPitchClass = null;

  for (let start = 0; start + windowSize <= source.length; start += hopSize) {
    const window = source.subarray(start, start + windowSize);
    let sumSquares = 0;
    for (let i = 0; i < window.length; i++) sumSquares += window[i] * window[i];
    const rms = Math.sqrt(sumSquares / window.length);
    if (rms < 0.01) continue;

    const freq = detectFundamentalFrequency(window, buffer.sampleRate);
    if (!freq) continue;

    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    if (!Number.isFinite(midi)) continue;

    const pitchClass = ((midi % 12) + 12) % 12;
    histogram[pitchClass] += rms;
    if (firstPitchClass === null) firstPitchClass = pitchClass;
    lastPitchClass = pitchClass;
    samplesUsed++;
  }

  if (firstPitchClass !== null) histogram[firstPitchClass] += 0.5;
  if (lastPitchClass !== null) histogram[lastPitchClass] += 1;

  return { histogram, samplesUsed, firstPitchClass, lastPitchClass };
}

function keyScore(histogram, profile, root) {
  let score = 0;
  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    score += histogram[pitchClass] * profile[(pitchClass - root + 12) % 12];
  }
  return score;
}

/**
 * Estimate the most likely musical key for a loop.
 *
 * @param {AudioBuffer} buffer
 * @returns {{ root: number, mode: 'major'|'minor', name: string, signature: number, confidence: number } | null}
 */
export function detectKey(buffer) {
  const { histogram, samplesUsed } = buildPitchClassHistogram(buffer);
  if (samplesUsed < 2) return null;

  let best = null;
  let secondBestScore = -Infinity;

  for (let root = 0; root < 12; root++) {
    const candidates = [
      {
        root,
        mode: 'major',
        score: keyScore(histogram, MAJOR_PROFILE, root),
        signature: MAJOR_SIGNATURES[root],
      },
      {
        root,
        mode: 'minor',
        score: keyScore(histogram, MINOR_PROFILE, root),
        signature: MINOR_SIGNATURES[root],
      },
    ];

    for (const candidate of candidates) {
      if (!best || candidate.score > best.score) {
        if (best) secondBestScore = best.score;
        best = candidate;
      } else if (candidate.score > secondBestScore) {
        secondBestScore = candidate.score;
      }
    }
  }

  if (!best || best.score <= 0) return null;

  return {
    root: best.root,
    mode: best.mode,
    name: `${NOTE_NAMES[best.root]} ${best.mode}`,
    signature: best.signature,
    confidence: Math.max(0, (best.score - secondBestScore) / best.score),
  };
}

/**
 * Return whether two detected keys are likely compatible enough to avoid a warning.
 *
 * @param {{ signature: number } | null} a
 * @param {{ signature: number } | null} b
 * @returns {boolean}
 */
export function areKeysLikelyCompatible(a, b) {
  if (!a || !b) return true;
  return Math.abs(a.signature - b.signature) <= 1;
}

/**
 * Return whether a new detected key should trigger a clash warning.
 *
 * @param {{ signature: number } | null} newKey
 * @param {Array<{ signature: number } | null>} existingKeys
 * @returns {boolean}
 */
export function shouldWarnAboutKeyClash(newKey, existingKeys) {
  if (!newKey) return false;
  const knownKeys = existingKeys.filter(Boolean);
  if (knownKeys.length === 0) return false;
  return knownKeys.every((existingKey) => !areKeysLikelyCompatible(newKey, existingKey));
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
