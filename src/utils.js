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
