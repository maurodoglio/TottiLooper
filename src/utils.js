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

/**
 * Convert elapsed transport time into a 1-based bar/beat position.
 *
 * @param {number} elapsedSeconds
 * @param {number} bpm
 * @param {number} beatsPerBar
 * @returns {{ bar: number, beat: number }}
 */
export function getBarBeatPosition(elapsedSeconds, bpm, beatsPerBar) {
  const safeBpm = Math.max(1, bpm || 0);
  const safeBeatsPerBar = Math.max(1, Math.floor(beatsPerBar || 0));
  const beatSeconds = 60 / safeBpm;
  // Nudge values by a tiny epsilon to avoid floating-point underflow at beat
  // boundaries (for example, 1.999999999 s instead of an exact 2.0 s).
  const totalBeats = Math.max(0, Math.floor(((elapsedSeconds || 0) + 1e-9) / beatSeconds));
  return {
    bar: Math.floor(totalBeats / safeBeatsPerBar) + 1,
    beat: (totalBeats % safeBeatsPerBar) + 1,
  };
}

/**
 * Format elapsed transport time as "Bar X • Beat Y".
 *
 * @param {number} elapsedSeconds
 * @param {number} bpm
 * @param {number} beatsPerBar
 * @returns {string}
 */
export function formatBarBeatPosition(elapsedSeconds, bpm, beatsPerBar) {
  const { bar, beat } = getBarBeatPosition(elapsedSeconds, bpm, beatsPerBar);
  return `Bar ${bar} • Beat ${beat}`;
}

/**
 * Parse a raw MIDI message into a small normalized descriptor.
 *
 * @param {ArrayLike<number>} data
 * @returns {{ kind: 'noteon' | 'noteoff' | 'cc', channel: number, number: number, value: number } | null}
 */
export function parseMidiMessage(data) {
  if (!data || data.length < 2) return null;
  const status = data[0];
  const number = data[1];
  const value = data[2] ?? 0;
  const command = status & 0xf0;
  const channel = (status & 0x0f) + 1;

  if (command === 0x90) {
    return { kind: value > 0 ? 'noteon' : 'noteoff', channel, number, value };
  }
  if (command === 0x80) {
    return { kind: 'noteoff', channel, number, value };
  }
  if (command === 0xb0) {
    return { kind: 'cc', channel, number, value };
  }
  return null;
}

/**
 * Build a binding descriptor from a parsed MIDI message.
 *
 * @param {{ kind: 'noteon' | 'noteoff' | 'cc', channel: number, number: number, value: number } | null} message
 * @param {'button' | 'range'} mode
 * @returns {{ source: 'note' | 'cc', channel: number, number: number, mode: 'button' | 'range' } | null}
 */
export function createMidiBinding(message, mode) {
  if (!message) return null;
  if (mode === 'range') {
    return message.kind === 'cc'
      ? { source: 'cc', channel: message.channel, number: message.number, mode }
      : null;
  }
  if (message.kind === 'cc') {
    return { source: 'cc', channel: message.channel, number: message.number, mode };
  }
  if (message.kind === 'noteon' || message.kind === 'noteoff') {
    return { source: 'note', channel: message.channel, number: message.number, mode };
  }
  return null;
}

/**
 * Check whether a parsed MIDI message matches a stored binding.
 *
 * @param {{ source: 'note' | 'cc', channel: number, number: number, mode: 'button' | 'range' } | null} binding
 * @param {{ kind: 'noteon' | 'noteoff' | 'cc', channel: number, number: number, value: number } | null} message
 * @returns {boolean}
 */
export function matchesMidiBinding(binding, message) {
  if (!binding || !message) return false;
  if (binding.source === 'note') {
    return (message.kind === 'noteon' || message.kind === 'noteoff')
      && binding.channel === message.channel
      && binding.number === message.number;
  }
  return message.kind === 'cc'
    && binding.channel === message.channel
    && binding.number === message.number;
}

/**
 * Whether a MIDI message should trigger a button-style action.
 *
 * @param {{ kind: 'noteon' | 'noteoff' | 'cc', channel: number, number: number, value: number } | null} message
 * @returns {boolean}
 */
export function isMidiButtonPress(message) {
  return !!message && (
    (message.kind === 'noteon' && message.value > 0)
    || (message.kind === 'cc' && message.value > 0)
  );
}

/**
 * Scale a MIDI 0-127 value into an arbitrary range.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function scaleMidiValue(value, min, max) {
  const clamped = Math.max(0, Math.min(127, value));
  return min + (clamped / 127) * (max - min);
}

/**
 * Format a MIDI binding for display in the learn UI.
 *
 * @param {{ source: 'note' | 'cc', channel: number, number: number, mode: 'button' | 'range' } | null} binding
 * @returns {string}
 */
export function formatMidiBinding(binding) {
  if (!binding) return 'Unassigned';
  return `${binding.source === 'note' ? 'Note' : 'CC'} ${binding.number} · Ch ${binding.channel}`;
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
 * Compute the effective output gain for a loop, accounting for mute, solo,
 * per-loop volume, and optional lead-loop ducking (reducing non-lead loops
 * while the lead loop is currently playing).
 *
 * @param {{ id?: number, muted: boolean, soloed: boolean, volume: number }} loop
 * @param {Array<{ id?: number, soloed: boolean, playing?: boolean }>} loops - the complete list of loops
 * @param {{ leadLoopId?: number|null, duckGain?: number }} [opts]
 * @returns {number}
 */
export function effectiveGain(loop, loops, opts = {}) {
  const {
    leadLoopId = null,
    duckGain = 0.35,
  } = opts;

  if (loop.muted) return 0;
  const anySolo = loops.some(l => l.soloed);
  if (anySolo && !loop.soloed) return 0;

  if (leadLoopId != null && loop.id !== leadLoopId) {
    const leadLoop = loops.find(l => l.id === leadLoopId);
    if (leadLoop && leadLoop.playing) {
      return loop.volume * duckGain;
    }
  }

  return loop.volume;
}

export function getLoopPlaybackRate(loop, bpm) {
  if (!loop.followTempo) return loop.playbackRate;
  const baseBpm = loop.tempoBaseBpm;
  if (!Number.isFinite(baseBpm) || baseBpm <= 0) return loop.playbackRate;
  return loop.playbackRate * (bpm / baseBpm);
}

// ─── Key detection ─────────────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SIGNATURES = [0, 7, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const MINOR_SIGNATURES = [-3, 4, -1, 6, 1, -4, 3, -2, 5, 0, 7, 2];
const MIN_KEY_RMS_THRESHOLD = 0.01;
const FIRST_NOTE_WEIGHT = 0.5;
const LAST_NOTE_WEIGHT = 1;

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
    if (rms < MIN_KEY_RMS_THRESHOLD) continue;

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

  if (firstPitchClass !== null) histogram[firstPitchClass] += FIRST_NOTE_WEIGHT;
  if (lastPitchClass !== null) histogram[lastPitchClass] += LAST_NOTE_WEIGHT;

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
 * Convert BPM into seconds per beat for the selected time-signature denominator.
 *
 * @param {number} bpm
 * @param {number} [beatUnit=4]
 * @returns {number}
 */
export function getBeatSeconds(bpm, beatUnit = 4) {
  return (60 / bpm) * (4 / beatUnit);
}

/**
 * Snap a recorded AudioBuffer's length to a whole number of bars.
 *
 * @param {AudioBuffer} buffer
 * @param {{ bpm: number, beatsPerBar: number, beatUnit?: number, audioContext: AudioContext }} opts
 * @returns {AudioBuffer}
 */
export function quantizeBuffer(buffer, { bpm, beatsPerBar, beatUnit = 4, audioContext }) {
  const barSeconds  = barsToDurationSeconds(1, { bpm, beatsPerBar, beatUnit });
  const numBars     = Math.max(1, Math.round(buffer.duration / barSeconds));
  return fitBufferToBars(buffer, { bars: numBars, bpm, beatsPerBar, beatUnit, audioContext });
}

/**
 * Convert a whole number of bars to seconds for the current tempo grid.
 *
 * @param {number} bars
 * @param {{ bpm: number, beatsPerBar: number }} opts
 * @returns {number}
 */
export function barsToDurationSeconds(bars, { bpm, beatsPerBar, beatUnit = 4 }) {
  return bars * getBeatSeconds(bpm, beatUnit) * beatsPerBar;
}

/**
 * Resize a recorded AudioBuffer to an exact number of bars by trimming or
 * zero-padding the tail as needed.
 *
 * @param {AudioBuffer} buffer
 * @param {{ bars: number, bpm: number, beatsPerBar: number, audioContext: AudioContext }} opts
 * @returns {AudioBuffer}
 */
export function fitBufferToBars(buffer, { bars, bpm, beatsPerBar, beatUnit = 4, audioContext }) {
  const wholeBars = Math.round(bars);
  if (!Number.isFinite(bars) || wholeBars < 1 || wholeBars !== bars) {
    throw new Error(`bars must be a whole number >= 1, got ${bars}`);
  }

  const targetDur   = barsToDurationSeconds(wholeBars, { bpm, beatsPerBar, beatUnit });
  const targetLen   = Math.round(targetDur * buffer.sampleRate);

  return resizeBuffer(buffer, targetLen, audioContext);
}

function resizeBuffer(buffer, targetLen, audioContext) {
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

/**
 * Overdub a recorded take onto a specific bar range of an existing loop.
 *
 * @param {AudioBuffer} loopBuffer
 * @param {AudioBuffer} takeBuffer
 * @param {{ startBar: number, endBar: number, bpm: number, beatsPerBar: number, audioContext: AudioContext }} opts
 * @returns {AudioBuffer}
 */
export function applyPunchIn(loopBuffer, takeBuffer, {
  startBar,
  endBar,
  bpm,
  beatsPerBar,
  audioContext,
}) {
  const beatSeconds = 60 / bpm;
  const barSeconds = beatSeconds * beatsPerBar;
  const startSample = Math.round((startBar - 1) * barSeconds * loopBuffer.sampleRate);
  const punchLength = Math.round((endBar - startBar + 1) * barSeconds * loopBuffer.sampleRate);

  const out = audioContext.createBuffer(
    loopBuffer.numberOfChannels,
    loopBuffer.length,
    loopBuffer.sampleRate,
  );

  for (let ch = 0; ch < loopBuffer.numberOfChannels; ch++) {
    const src = loopBuffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src);

    const takeCh = Math.min(ch, takeBuffer.numberOfChannels - 1);
    const take = takeBuffer.getChannelData(takeCh);
    const overlayLength = Math.max(0, Math.min(
      punchLength,
      take.length,
      loopBuffer.length - startSample,
    ));

    for (let i = 0; i < overlayLength; i++) {
      const mixed = dst[startSample + i] + take[i];
      dst[startSample + i] = Math.max(-1, Math.min(1, mixed));
    }
  }

  return out;
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
  let pitched = cloneBuffer(buffer, audioContext);
  if (Math.abs(pitchRatio - 1) >= 1e-6) {
    pitched = resampleBuffer(buffer, pitchRatio, audioContext);
  }
  const stretchFactor = pitchRatio / speed;
  if (Math.abs(stretchFactor - 1) < 1e-6) return pitched;
  return timeStretchBuffer(pitched, stretchFactor, audioContext);
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

/**
 * Create a non-destructively edited copy of an AudioBuffer with optional trim
 * points and fade-in / fade-out envelopes applied.
 *
 * @param {AudioBuffer} buffer
 * @param {{
 *   trimStart?: number,
 *   trimEnd?: number,
 *   fadeIn?: number,
 *   fadeOut?: number,
 *   audioContext: AudioContext,
 * }} opts
 * @returns {AudioBuffer}
 */
export function applyLoopEdits(buffer, {
  trimStart = 0,
  trimEnd = buffer.duration,
  fadeIn = 0,
  fadeOut = 0,
  audioContext,
}) {
  const sampleRate = buffer.sampleRate;
  const minFrames = 1;
  const startFrame = Math.max(0, Math.min(buffer.length - minFrames, Math.floor(trimStart * sampleRate)));
  const endFrame = Math.max(
    startFrame + minFrames,
    Math.min(buffer.length, Math.ceil(trimEnd * sampleRate)),
  );
  const outLength = Math.max(minFrames, endFrame - startFrame);
  const fadeInFrames = Math.max(0, Math.min(outLength, Math.round(fadeIn * sampleRate)));
  const fadeOutFrames = Math.max(0, Math.min(outLength, Math.round(fadeOut * sampleRate)));

  const out = audioContext.createBuffer(
    buffer.numberOfChannels,
    outLength,
    sampleRate,
  );

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(startFrame, endFrame));

    for (let i = 0; i < outLength; i++) {
      let gain = 1;
      if (fadeInFrames > 0 && i < fadeInFrames) {
        gain = Math.min(gain, i / fadeInFrames);
      }
      if (fadeOutFrames > 0 && i >= outLength - fadeOutFrames) {
        gain = Math.min(gain, (outLength - 1 - i) / fadeOutFrames);
      }
      if (gain < 1) dst[i] *= Math.max(0, gain);
    }
  }

  return out;
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

// ─── Shared-session encoding ──────────────────────────────────────────────────

function toBase64(bytes) {
  if (typeof globalThis.Buffer !== 'undefined') {
    return globalThis.Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(base64) {
  if (typeof globalThis.Buffer !== 'undefined') {
    return Uint8Array.from(globalThis.Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(base64Url) {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  // Base64 decoding requires a length that's divisible by 4.
  const base64 = padded + '='.repeat((4 - (padded.length % 4 || 4)) % 4);
  return fromBase64(base64);
}

/**
 * Encode a shareable session payload into a compact URL-safe string.
 *
 * @param {{
 *   bpm: number,
 *   beatsPerBar: number,
 *   masterVolume: number,
 *   loops: Array<{
 *     name: string,
 *     volume: number,
 *     pan: number,
 *     playbackRate: number,
 *     muted: boolean,
 *     soloed: boolean,
 *     reversed: boolean,
 *     mimeType: string,
 *     audioBytes: Uint8Array
 *   }>
 * }} session
 * @returns {string}
 */
export function packSharedSession(session) {
  const manifest = {
    v: 1,
    b: session.bpm,
    bb: session.beatsPerBar,
    mv: session.masterVolume,
    l: session.loops.map((loop) => ({
      n: loop.name,
      v: loop.volume,
      p: loop.pan,
      r: loop.playbackRate,
      m: loop.muted ? 1 : 0,
      s: loop.soloed ? 1 : 0,
      x: loop.reversed ? 1 : 0,
      t: loop.mimeType,
      z: loop.audioBytes.length,
    })),
  };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const totalAudioBytes = session.loops.reduce((sum, loop) => sum + loop.audioBytes.length, 0);
  const out = new Uint8Array(4 + manifestBytes.length + totalAudioBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, manifestBytes.length, true);
  out.set(manifestBytes, 4);

  let offset = 4 + manifestBytes.length;
  for (const loop of session.loops) {
    out.set(loop.audioBytes, offset);
    offset += loop.audioBytes.length;
  }

  return toBase64Url(out);
}

/**
 * Decode a shared-session payload from a URL-safe string.
 *
 * @param {string} packed
 * @returns {{
 *   bpm: number,
 *   beatsPerBar: number,
 *   masterVolume: number,
 *   loops: Array<{
 *     name: string,
 *     volume: number,
 *     pan: number,
 *     playbackRate: number,
 *     muted: boolean,
 *     soloed: boolean,
 *     reversed: boolean,
 *     mimeType: string,
 *     audioBytes: Uint8Array
 *   }>
 * }}
 */
export function unpackSharedSession(packed) {
  const bytes = fromBase64Url(packed);
  if (bytes.length < 5) throw new Error('Shared session is truncated.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestLength = view.getUint32(0, true);
  const manifestEnd = 4 + manifestLength;
  if (manifestEnd > bytes.length) throw new Error('Shared session manifest is invalid.');

  const manifestText = new TextDecoder().decode(bytes.subarray(4, manifestEnd));
  const manifest = JSON.parse(manifestText);
  if (manifest.v !== 1 || !Array.isArray(manifest.l)) {
    throw new Error('Shared session version is not supported.');
  }

  let offset = manifestEnd;
  const loops = manifest.l.map((loop) => {
    const end = offset + loop.z;
    if (end > bytes.length) throw new Error('Shared session audio data is incomplete.');
    const audioBytes = bytes.slice(offset, end);
    offset = end;
    return {
      name: loop.n,
      volume: loop.v,
      pan: loop.p,
      playbackRate: loop.r,
      muted: !!loop.m,
      soloed: !!loop.s,
      reversed: !!loop.x,
      mimeType: loop.t,
      audioBytes,
    };
  });

  if (offset !== bytes.length) throw new Error('Shared session payload has unexpected trailing data.');

  return {
    bpm: manifest.b,
    beatsPerBar: manifest.bb,
    masterVolume: manifest.mv,
    loops,
  };
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
