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
 * Estimate tempo (BPM) from an AudioBuffer using a simple onset envelope and
 * autocorrelation over plausible beat intervals.
 *
 * @param {AudioBuffer} buffer
 * @param {{ minBpm?: number, maxBpm?: number, frameSize?: number }} [opts]
 * @returns {number|null}
 */
export function estimateTempo(buffer, opts = {}) {
  if (!buffer || !buffer.length || !buffer.sampleRate || !buffer.numberOfChannels) return null;

  const minBpm = Math.max(1, opts.minBpm ?? 40);
  const maxBpm = Math.max(minBpm, opts.maxBpm ?? 240);
  const frameSize = Math.max(128, opts.frameSize ?? 512);
  const frameCount = Math.floor(buffer.length / frameSize);
  if (frameCount < 8) return null;

  const envelope = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameSize;
    let energy = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < frameSize; i++) {
        energy += Math.abs(data[start + i] || 0);
      }
    }
    envelope[frame] = energy / (frameSize * buffer.numberOfChannels);
  }

  const novelty = new Float32Array(frameCount);
  let noveltyTotal = 0;
  let noveltyPeak = 0;
  for (let i = 1; i < frameCount; i++) {
    const rise = envelope[i] - envelope[i - 1];
    if (rise > 0) {
      novelty[i] = rise;
      noveltyTotal += rise;
      if (rise > noveltyPeak) noveltyPeak = rise;
    }
  }
  if (noveltyPeak < 1e-4) return null;

  const floor = (noveltyTotal / frameCount) * 0.5;
  let filteredPeak = 0;
  for (let i = 0; i < frameCount; i++) {
    novelty[i] = Math.max(0, novelty[i] - floor);
    if (novelty[i] > filteredPeak) filteredPeak = novelty[i];
  }
  if (filteredPeak < 1e-4) return null;

  const framesPerSecond = buffer.sampleRate / frameSize;
  const peakThreshold = filteredPeak * 0.35;
  const minPeakDistance = Math.max(1, Math.floor(framesPerSecond * 0.18));
  const peaks = [];
  for (let i = 1; i < frameCount - 1; i++) {
    if (novelty[i] < peakThreshold) continue;
    if (novelty[i] < novelty[i - 1] || novelty[i] < novelty[i + 1]) continue;
    const lastPeak = peaks[peaks.length - 1];
    if (lastPeak !== undefined && i - lastPeak < minPeakDistance) {
      if (novelty[i] > novelty[lastPeak]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }

  if (peaks.length >= 2) {
    const votes = new Map();
    for (let i = 0; i < peaks.length - 1; i++) {
      for (let j = i + 1; j < Math.min(peaks.length, i + 5); j++) {
        const interval = peaks[j] - peaks[i];
        if (interval <= 0) continue;
        let candidateBpm = Math.round((60 * framesPerSecond * (j - i)) / interval);
        while (candidateBpm < minBpm) candidateBpm *= 2;
        while (candidateBpm > maxBpm) candidateBpm = Math.round(candidateBpm / 2);
        const weight = 1 / (j - i);
        votes.set(candidateBpm, (votes.get(candidateBpm) || 0) + weight);
      }
    }

    let votedBpm = null;
    let votedScore = 0;
    for (const [candidateBpm, score] of votes.entries()) {
      if (score > votedScore) {
        votedBpm = candidateBpm;
        votedScore = score;
      }
    }
    if (votedBpm !== null) return votedBpm;
  }

  const minLag = Math.max(1, Math.floor((60 / maxBpm) * framesPerSecond));
  const maxLag = Math.min(frameCount - 1, Math.ceil((60 / minBpm) * framesPerSecond));
  if (maxLag <= minLag) return null;

  const scores = new Float32Array(maxLag + 1);
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = lag; i < frameCount; i++) {
      score += novelty[i] * novelty[i - lag];
    }
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore <= 0) return null;

  while (bestLag / 2 >= minLag) {
    const halfLag = Math.round(bestLag / 2);
    if (scores[halfLag] < bestScore * 0.9) break;
    bestLag = halfLag;
    bestScore = scores[halfLag];
  }

  const estimated = Math.round((60 * framesPerSecond) / bestLag);
  return Math.max(minBpm, Math.min(maxBpm, estimated));
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
