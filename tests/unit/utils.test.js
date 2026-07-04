/**
 * Unit tests for src/utils.js.
 *
 * All pure-function logic is tested here in a plain Node environment – no
 * browser, no jsdom, no mocking of DOM globals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDuration,
  formatBarBeatPosition,
  panText,
  parseMidiMessage,
  createMidiBinding,
  matchesMidiBinding,
  isMidiButtonPress,
  scaleMidiValue,
  formatMidiBinding,
  writeString,
  audioBufferToWav,
  applyPunchIn,
  createBuiltinSampleLoop,
  clickTrackToMidi,
  getSupportedMimeType,
  effectiveGain,
  normalizeSongTimeline,
  getLoopPlaybackRate,
  fitBufferToBars,
  getBeatSeconds,
  applyLoopEdits,
  detectKey,
  areKeysLikelyCompatible,
  shouldWarnAboutKeyClash,
  estimateTempo,
  getBarBeatPosition,
  packSharedSession,
  quantizeBuffer,
  offsetBuffer,
  reverseBuffer,
  makeDistortionCurve,
  makeReverbIR,
  resampleBuffer,
  timeStretchBuffer,
  transformBuffer,
  unpackSharedSession,
  clampSceneCrossfadeBars,
  sceneCrossfadeDuration,
} from '../../src/utils.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal mock AudioContext whose createBuffer returns real Float32Arrays. */
function makeMockAudioContext(sampleRate = 44100) {
  return {
    sampleRate,
    createBuffer(channels, length, sr) {
      const channelData = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate: sr,
        duration: length / sr,
        getChannelData: (ch) => channelData[ch],
      };
    },
  };
}

function frequencyForMidi(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function makeMelodyBuffer(midis, sampleRate = 44100, noteDuration = 0.12) {
  const FADE_SAMPLES = 256;
  const samplesPerNote = Math.floor(sampleRate * noteDuration);
  const totalSamples = samplesPerNote * midis.length;
  const data = new Float32Array(totalSamples);

  midis.forEach((midi, noteIndex) => {
    const freq = frequencyForMidi(midi);
    const start = noteIndex * samplesPerNote;
    for (let i = 0; i < samplesPerNote; i++) {
      const t = i / sampleRate;
      const fade = Math.min(1, i / FADE_SAMPLES, (samplesPerNote - i) / FADE_SAMPLES);
      data[start + i] = Math.sin(2 * Math.PI * freq * t) * 0.5 * fade;
    }
  });

  return {
    numberOfChannels: 1,
    length: totalSamples,
    sampleRate,
    duration: totalSamples / sampleRate,
    getChannelData: () => data,
  };
}

// ─── formatDuration ───────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats zero as 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('pads single-digit seconds with a leading zero', () => {
    expect(formatDuration(5)).toBe('0:05');
  });

  it('formats exactly one minute', () => {
    expect(formatDuration(60)).toBe('1:00');
  });

  it('formats 65 seconds as 1:05', () => {
    expect(formatDuration(65)).toBe('1:05');
  });

  it('formats large values (over an hour)', () => {
    expect(formatDuration(3661)).toBe('61:01');
  });

  it('truncates fractional seconds (does not round up)', () => {
    // 59.9 s should still show 0:59, not 1:00
    expect(formatDuration(59.9)).toBe('0:59');
  });
});

// ─── panText ─────────────────────────────────────────────────────────────────

describe('panText', () => {
  it('returns C for exactly 0', () => {
    expect(panText(0)).toBe('C');
  });

  it('returns C for a value within the ±0.02 dead-zone', () => {
    expect(panText(0.01)).toBe('C');
    expect(panText(-0.019)).toBe('C');
  });

  it('returns L followed by the percentage for a left pan', () => {
    expect(panText(-0.5)).toBe('L50');
    expect(panText(-1)).toBe('L100');
  });

  it('returns R followed by the percentage for a right pan', () => {
    expect(panText(0.75)).toBe('R75');
    expect(panText(1)).toBe('R100');
  });

  it('rounds the percentage to the nearest integer', () => {
    expect(panText(0.333)).toBe('R33');
    expect(panText(-0.666)).toBe('L67');
  });
});

// ─── bar / beat position ──────────────────────────────────────────────────────

describe('getBarBeatPosition', () => {
  it('starts at bar 1 beat 1', () => {
    expect(getBarBeatPosition(0, 120, 4)).toEqual({ bar: 1, beat: 1 });
  });

  it('advances beats based on the BPM', () => {
    expect(getBarBeatPosition(0.5, 120, 4)).toEqual({ bar: 1, beat: 2 });
  });

  it('wraps to the next bar after the final beat', () => {
    expect(getBarBeatPosition(2, 120, 4)).toEqual({ bar: 2, beat: 1 });
  });

  it('handles custom beats-per-bar values', () => {
    expect(getBarBeatPosition(2, 120, 3)).toEqual({ bar: 2, beat: 2 });
  });
});

describe('formatBarBeatPosition', () => {
  it('formats the computed transport position', () => {
    expect(formatBarBeatPosition(1.5, 120, 4)).toBe('Bar 1 • Beat 4');
  });
});

// ─── MIDI helpers ─────────────────────────────────────────────────────────────

describe('parseMidiMessage', () => {
  it('parses note-on messages', () => {
    expect(parseMidiMessage([0x90, 36, 127])).toEqual({
      kind: 'noteon',
      channel: 1,
      number: 36,
      value: 127,
    });
  });

  it('treats note-on with zero velocity as note-off', () => {
    expect(parseMidiMessage([0x90, 36, 0])).toEqual({
      kind: 'noteoff',
      channel: 1,
      number: 36,
      value: 0,
    });
  });

  it('parses control-change messages', () => {
    expect(parseMidiMessage([0xb2, 7, 99])).toEqual({
      kind: 'cc',
      channel: 3,
      number: 7,
      value: 99,
    });
  });

  it('returns null for unsupported MIDI messages', () => {
    expect(parseMidiMessage([0xe0, 0, 64])).toBeNull();
  });
});

describe('createMidiBinding', () => {
  it('creates button bindings from note messages', () => {
    expect(createMidiBinding({ kind: 'noteon', channel: 2, number: 48, value: 100 }, 'button')).toEqual({
      source: 'note',
      channel: 2,
      number: 48,
      mode: 'button',
    });
  });

  it('creates range bindings only from CC messages', () => {
    expect(createMidiBinding({ kind: 'cc', channel: 1, number: 11, value: 64 }, 'range')).toEqual({
      source: 'cc',
      channel: 1,
      number: 11,
      mode: 'range',
    });
    expect(createMidiBinding({ kind: 'noteon', channel: 1, number: 11, value: 64 }, 'range')).toBeNull();
  });
});

describe('matchesMidiBinding', () => {
  it('matches note bindings against note-on and note-off messages on the same key and channel', () => {
    const binding = { source: 'note', channel: 4, number: 60, mode: 'button' };
    expect(matchesMidiBinding(binding, { kind: 'noteon', channel: 4, number: 60, value: 100 })).toBe(true);
    expect(matchesMidiBinding(binding, { kind: 'noteoff', channel: 4, number: 60, value: 0 })).toBe(true);
  });

  it('does not match different channels or controller numbers', () => {
    const binding = { source: 'cc', channel: 1, number: 7, mode: 'range' };
    expect(matchesMidiBinding(binding, { kind: 'cc', channel: 2, number: 7, value: 64 })).toBe(false);
    expect(matchesMidiBinding(binding, { kind: 'cc', channel: 1, number: 10, value: 64 })).toBe(false);
  });
});

describe('isMidiButtonPress', () => {
  it('returns true for note-on and non-zero CC messages', () => {
    expect(isMidiButtonPress({ kind: 'noteon', channel: 1, number: 36, value: 1 })).toBe(true);
    expect(isMidiButtonPress({ kind: 'cc', channel: 1, number: 36, value: 1 })).toBe(true);
  });

  it('returns false for note-off and zero-value CC messages', () => {
    expect(isMidiButtonPress({ kind: 'noteoff', channel: 1, number: 36, value: 0 })).toBe(false);
    expect(isMidiButtonPress({ kind: 'cc', channel: 1, number: 36, value: 0 })).toBe(false);
  });
});

describe('scaleMidiValue', () => {
  it('maps the full MIDI range into the requested output range', () => {
    expect(scaleMidiValue(0, 0, 1.5)).toBe(0);
    expect(scaleMidiValue(127, 0, 1.5)).toBe(1.5);
  });

  it('clamps values outside the MIDI range', () => {
    expect(scaleMidiValue(-10, 0, 1)).toBe(0);
    expect(scaleMidiValue(200, 0, 1)).toBe(1);
  });
});

describe('formatMidiBinding', () => {
  it('formats note and CC bindings for display', () => {
    expect(formatMidiBinding({ source: 'note', channel: 1, number: 36, mode: 'button' })).toBe('Note 36 · Ch 1');
    expect(formatMidiBinding({ source: 'cc', channel: 2, number: 7, mode: 'range' })).toBe('CC 7 · Ch 2');
  });

  it('formats empty bindings as Unassigned', () => {
    expect(formatMidiBinding(null)).toBe('Unassigned');
  });
});

// ─── effectiveGain ────────────────────────────────────────────────────────────

describe('effectiveGain', () => {
  it('returns 0 for a muted loop', () => {
    const loop = { muted: true, soloed: false, volume: 1 };
    expect(effectiveGain(loop, [loop])).toBe(0);
  });

  it('returns the loop volume when nothing is muted or soloed', () => {
    const loop = { muted: false, soloed: false, volume: 0.8 };
    expect(effectiveGain(loop, [loop])).toBe(0.8);
  });

  it('returns 0 for a non-soloed loop when another loop is soloed', () => {
    const loop1 = { muted: false, soloed: false, volume: 1 };
    const loop2 = { muted: false, soloed: true, volume: 1 };
    expect(effectiveGain(loop1, [loop1, loop2])).toBe(0);
  });

  it('returns the volume for the soloed loop when a solo is active', () => {
    const loop1 = { muted: false, soloed: true, volume: 0.7 };
    const loop2 = { muted: false, soloed: false, volume: 1 };
    expect(effectiveGain(loop1, [loop1, loop2])).toBe(0.7);
  });

  it('returns 0 for a muted-and-soloed loop (mute takes priority)', () => {
    const loop = { muted: true, soloed: true, volume: 1 };
    expect(effectiveGain(loop, [loop])).toBe(0);
  });

  it('returns 0 for every loop when volume is 0', () => {
    const loop = { muted: false, soloed: false, volume: 0 };
    expect(effectiveGain(loop, [loop])).toBe(0);
  });

  // ── Group-aware behaviour ────────────────────────────────────────────────

  it('multiplies loop volume by group volume', () => {
    const group = { id: 1, volume: 0.5, muted: false, soloed: false };
    const loop = { muted: false, soloed: false, volume: 0.8, groupId: 1 };
    expect(effectiveGain(loop, [loop], [group])).toBeCloseTo(0.4);
  });

  it('returns 0 when the group is muted', () => {
    const group = { id: 1, volume: 1, muted: true, soloed: false };
    const loop = { muted: false, soloed: false, volume: 1, groupId: 1 };
    expect(effectiveGain(loop, [loop], [group])).toBe(0);
  });

  it('loop mute still takes priority over a non-muted group', () => {
    const group = { id: 1, volume: 1, muted: false, soloed: false };
    const loop = { muted: true, soloed: false, volume: 1, groupId: 1 };
    expect(effectiveGain(loop, [loop], [group])).toBe(0);
  });

  it('returns 0 for a loop outside the soloed group when a group is soloed', () => {
    const group1 = { id: 1, volume: 1, muted: false, soloed: true };
    const group2 = { id: 2, volume: 1, muted: false, soloed: false };
    const loopInGroup1 = { muted: false, soloed: false, volume: 1, groupId: 1 };
    const loopInGroup2 = { muted: false, soloed: false, volume: 1, groupId: 2 };
    expect(effectiveGain(loopInGroup2, [loopInGroup1, loopInGroup2], [group1, group2])).toBe(0);
  });

  it('returns volume for a loop inside the soloed group', () => {
    const group1 = { id: 1, volume: 0.8, muted: false, soloed: true };
    const group2 = { id: 2, volume: 1, muted: false, soloed: false };
    const loopInGroup1 = { muted: false, soloed: false, volume: 1, groupId: 1 };
    const loopInGroup2 = { muted: false, soloed: false, volume: 1, groupId: 2 };
    expect(effectiveGain(loopInGroup1, [loopInGroup1, loopInGroup2], [group1, group2])).toBeCloseTo(0.8);
  });

  it('loop solo still silences other loops even when a group is present', () => {
    const group = { id: 1, volume: 1, muted: false, soloed: false };
    const soloedLoop = { muted: false, soloed: true, volume: 1, groupId: 1 };
    const otherLoop  = { muted: false, soloed: false, volume: 1, groupId: 1 };
    expect(effectiveGain(otherLoop, [soloedLoop, otherLoop], [group])).toBe(0);
  });

  it('ungrouped loop (groupId null) is unaffected by group state', () => {
    const group = { id: 1, volume: 0.5, muted: true, soloed: true };
    const loop = { muted: false, soloed: false, volume: 0.9, groupId: null };
    // No solo applies to the ungrouped loop, and group mute doesn't apply.
    // The only active solo is from the group – but the loop has no group.
    // Because anySolo is true (group is soloed) and the loop is neither soloed
    // nor in a soloed group, its gain should be 0.
    expect(effectiveGain(loop, [loop], [group])).toBe(0);
  });

  it('ungrouped loop plays normally when no solo is active', () => {
    const group = { id: 1, volume: 0.5, muted: false, soloed: false };
    const loop = { muted: false, soloed: false, volume: 0.9, groupId: null };
    expect(effectiveGain(loop, [loop], [group])).toBeCloseTo(0.9);
  });

  it('ducks non-lead loops when a lead loop is currently playing', () => {
    const lead = { id: 1, muted: false, soloed: false, volume: 1, playing: true };
    const backing = { id: 2, muted: false, soloed: false, volume: 0.8, playing: true };
    expect(effectiveGain(backing, [lead, backing], { leadLoopId: 1, duckGain: 0.25 })).toBeCloseTo(0.2, 6);
  });

  it('does not duck the designated lead loop itself', () => {
    const lead = { id: 1, muted: false, soloed: false, volume: 0.9, playing: true };
    const backing = { id: 2, muted: false, soloed: false, volume: 1, playing: true };
    expect(effectiveGain(lead, [lead, backing], { leadLoopId: 1, duckGain: 0.25 })).toBe(0.9);
  });

  it('does not duck other loops when the lead is not playing', () => {
    const lead = { id: 1, muted: false, soloed: false, volume: 1, playing: false };
    const backing = { id: 2, muted: false, soloed: false, volume: 0.7, playing: true };
    expect(effectiveGain(backing, [lead, backing], { leadLoopId: 1, duckGain: 0.25 })).toBe(0.7);
  });
});

// ─── key detection ─────────────────────────────────────────────────────────────

describe('detectKey', () => {
  it('identifies a C major scale phrase as C major', () => {
    const buffer = makeMelodyBuffer([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(detectKey(buffer)).toMatchObject({ name: 'C major', mode: 'major', root: 0 });
  });

  it('identifies an A natural minor scale phrase as A minor', () => {
    const buffer = makeMelodyBuffer([57, 59, 60, 62, 64, 65, 67, 69]);
    expect(detectKey(buffer)).toMatchObject({ name: 'A minor', mode: 'minor', root: 9 });
  });

  it('returns null when there is not enough pitched content', () => {
    const silent = {
      numberOfChannels: 1,
      length: 4096,
      sampleRate: 44100,
      duration: 4096 / 44100,
      getChannelData: () => new Float32Array(4096),
    };
    expect(detectKey(silent)).toBeNull();
  });
});

describe('key clash helpers', () => {
  const cMajor = { name: 'C major', signature: 0 };
  const aMinor = { name: 'A minor', signature: 0 };
  const gMajor = { name: 'G major', signature: 1 };
  const eMajor = { name: 'E major', signature: 4 };

  it('treats relative major/minor keys as compatible', () => {
    expect(areKeysLikelyCompatible(cMajor, aMinor)).toBe(true);
  });

  it('treats neighboring key signatures as compatible', () => {
    expect(areKeysLikelyCompatible(cMajor, gMajor)).toBe(true);
  });

  it('warns only when every known existing key appears incompatible', () => {
    expect(shouldWarnAboutKeyClash(eMajor, [cMajor, gMajor])).toBe(true);
    expect(shouldWarnAboutKeyClash(gMajor, [cMajor, eMajor])).toBe(false);
  });
});

// ─── getLoopPlaybackRate ──────────────────────────────────────────────────────

describe('getLoopPlaybackRate', () => {
  it('returns the manual playback rate when follow tempo is disabled', () => {
    expect(getLoopPlaybackRate({ playbackRate: 0.8, followTempo: false, tempoBaseBpm: 100 }, 140)).toBe(0.8);
  });

  it('multiplies the playback rate by the BPM ratio when follow tempo is enabled', () => {
    expect(getLoopPlaybackRate({ playbackRate: 1, followTempo: true, tempoBaseBpm: 100 }, 150)).toBe(1.5);
  });

  it('preserves manual speed adjustments while following tempo', () => {
    expect(getLoopPlaybackRate({ playbackRate: 0.75, followTempo: true, tempoBaseBpm: 120 }, 180)).toBe(1.125);
  });

  it('falls back to the manual playback rate when the base BPM is invalid', () => {
    expect(getLoopPlaybackRate({ playbackRate: 1.1, followTempo: true, tempoBaseBpm: 0 }, 160)).toBe(1.1);
  });
});

// ─── normalizeSongTimeline ─────────────────────────────────────────────────────

describe('normalizeSongTimeline', () => {
  it('defaults invalid values to a one-bar window inside the song', () => {
    expect(normalizeSongTimeline(0, 0, 0)).toEqual({ startBar: 1, barCount: 1 });
  });

  it('clamps the start bar to the song length', () => {
    expect(normalizeSongTimeline(99, 2, 8)).toEqual({ startBar: 8, barCount: 1 });
  });

  it('keeps a valid range unchanged', () => {
    expect(normalizeSongTimeline(5, 4, 8)).toEqual({ startBar: 5, barCount: 4 });
  });

  it('shrinks the bar count when the range would run past the end', () => {
    expect(normalizeSongTimeline(7, 4, 8)).toEqual({ startBar: 7, barCount: 2 });
  });
});

// ─── scenes ───────────────────────────────────────────────────────────────────

describe('clampSceneCrossfadeBars', () => {
  it('defaults invalid values to 1 bar', () => {
    expect(clampSceneCrossfadeBars(NaN)).toBe(1);
  });

  it('clamps values below the supported range', () => {
    expect(clampSceneCrossfadeBars(0)).toBe(1);
  });

  it('clamps values above the supported range', () => {
    expect(clampSceneCrossfadeBars(8)).toBe(4);
  });

  it('rounds fractional values to the nearest supported bar count', () => {
    expect(clampSceneCrossfadeBars(2.6)).toBe(3);
  });
});

describe('sceneCrossfadeDuration', () => {
  it('returns the correct duration in seconds for the given tempo', () => {
    expect(sceneCrossfadeDuration(120, 4, 2)).toBe(4);
  });

  it('uses the clamped bar count when computing the duration', () => {
    expect(sceneCrossfadeDuration(100, 4, 9)).toBeCloseTo(9.6);
  });
});

// ─── writeString ─────────────────────────────────────────────────────────────

describe('writeString', () => {
  it('writes ASCII bytes into a DataView at the correct offset', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    writeString(view, 0, 'RIFF');
    expect(view.getUint8(0)).toBe('R'.charCodeAt(0));
    expect(view.getUint8(1)).toBe('I'.charCodeAt(0));
    expect(view.getUint8(2)).toBe('F'.charCodeAt(0));
    expect(view.getUint8(3)).toBe('F'.charCodeAt(0));
  });

  it('respects a non-zero starting offset', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    writeString(view, 4, 'WAVE');
    expect(view.getUint8(4)).toBe('W'.charCodeAt(0));
    expect(view.getUint8(7)).toBe('E'.charCodeAt(0));
    // Bytes before offset remain 0
    expect(view.getUint8(0)).toBe(0);
  });
});

// ─── audioBufferToWav ─────────────────────────────────────────────────────────

describe('audioBufferToWav', () => {
  it('returns a Blob with the audio/wav MIME type', () => {
    const mockBuffer = {
      numberOfChannels: 1,
      sampleRate: 44100,
      length: 100,
      getChannelData: () => new Float32Array(100),
    };
    const blob = audioBufferToWav(mockBuffer);
    expect(blob.type).toBe('audio/wav');
  });

  it('produces the correct total byte size for a mono buffer', () => {
    const frames = 100;
    const mockBuffer = {
      numberOfChannels: 1,
      sampleRate: 44100,
      length: frames,
      getChannelData: () => new Float32Array(frames),
    };
    const blob = audioBufferToWav(mockBuffer);
    // 44-byte header + (frames × channels × 2 bytes per sample)
    expect(blob.size).toBe(44 + frames * 1 * 2);
  });

  it('produces the correct total byte size for a stereo buffer', () => {
    const frames = 200;
    const mockBuffer = {
      numberOfChannels: 2,
      sampleRate: 44100,
      length: frames,
      getChannelData: () => new Float32Array(frames),
    };
    const blob = audioBufferToWav(mockBuffer);
    expect(blob.size).toBe(44 + frames * 2 * 2);
  });

  it('writes valid RIFF/WAVE header bytes', async () => {
    const mockBuffer = {
      numberOfChannels: 1,
      sampleRate: 44100,
      length: 10,
      getChannelData: () => new Float32Array(10),
    };
    const blob = audioBufferToWav(mockBuffer);
    const ab = await blob.arrayBuffer();
    const view = new DataView(ab);
    // "RIFF"
    expect(view.getUint8(0)).toBe(0x52); // R
    expect(view.getUint8(1)).toBe(0x49); // I
    expect(view.getUint8(2)).toBe(0x46); // F
    expect(view.getUint8(3)).toBe(0x46); // F
    // "WAVE"
    expect(view.getUint8(8)).toBe(0x57);  // W
    expect(view.getUint8(9)).toBe(0x41);  // A
    expect(view.getUint8(10)).toBe(0x56); // V
    expect(view.getUint8(11)).toBe(0x45); // E
  });

  it('clamps sample values that exceed ±1', async () => {
    // Feed a sample that is way out of range; after clamping it should encode as
    // the maximum positive 16-bit PCM value (0x7fff = 32767).
    const mockBuffer = {
      numberOfChannels: 1,
      sampleRate: 44100,
      length: 1,
      getChannelData: () => new Float32Array([5.0]),
    };
    const blob = audioBufferToWav(mockBuffer);
    const ab = await blob.arrayBuffer();
    const view = new DataView(ab);
    const sample = view.getInt16(44, true);
    expect(sample).toBe(0x7fff);
  });
});

// ─── clickTrackToMidi ──────────────────────────────────────────────────────────

describe('clickTrackToMidi', () => {
  async function midiBytes(opts) {
    return new Uint8Array(await clickTrackToMidi(opts).arrayBuffer());
  }

  it('returns a Blob with the audio/midi MIME type', () => {
    const blob = clickTrackToMidi({ bpm: 120, beatsPerBar: 4, durationSeconds: 4 });
    expect(blob.type).toBe('audio/midi');
  });

  it('writes a standard MIDI header with one track', async () => {
    const bytes = await midiBytes({ bpm: 120, beatsPerBar: 4, durationSeconds: 4 });
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    expect(String.fromCharCode(...bytes.slice(14, 18))).toBe('MTrk');
    expect(bytes[11]).toBe(1);
    expect(bytes[12]).toBe(0x01);
    expect(bytes[13]).toBe(0xe0);
  });

  it('stores tempo and time-signature metadata for the session settings', async () => {
    const bytes = await midiBytes({ bpm: 100, beatsPerBar: 3, durationSeconds: 4 });
    const data = Array.from(bytes);
    expect(data).toEqual(expect.arrayContaining([0xff, 0x51, 0x03, 0x09, 0x27, 0xc0]));
    expect(data).toEqual(expect.arrayContaining([0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08]));
  });

  it('creates one click note per beat across the exported duration', async () => {
    const bytes = await midiBytes({ bpm: 120, beatsPerBar: 4, durationSeconds: 4 });
    const data = Array.from(bytes);
    expect(data.filter((byte) => byte === 0x99)).toHaveLength(8);
    // 76 = accented downbeat click, 77 = regular click.
    expect(data.filter((byte, idx) => byte === 76 && data[idx - 1] === 0x99)).toHaveLength(2);
    expect(data.filter((byte, idx) => byte === 77 && data[idx - 1] === 0x99)).toHaveLength(6);
  });
});

// ─── getSupportedMimeType ─────────────────────────────────────────────────────

describe('getSupportedMimeType', () => {
  beforeEach(() => {
    // Provide a fresh MediaRecorder stub before each test.
    vi.stubGlobal('MediaRecorder', { isTypeSupported: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the first supported type', () => {
    globalThis.MediaRecorder.isTypeSupported.mockImplementation(
      (t) => t === 'audio/webm;codecs=opus',
    );
    expect(getSupportedMimeType()).toBe('audio/webm;codecs=opus');
  });

  it('falls back to audio/webm when opus is not supported', () => {
    globalThis.MediaRecorder.isTypeSupported.mockImplementation((t) => t === 'audio/webm');
    expect(getSupportedMimeType()).toBe('audio/webm');
  });

  it('returns an empty string when no type is supported', () => {
    globalThis.MediaRecorder.isTypeSupported.mockReturnValue(false);
    expect(getSupportedMimeType()).toBe('');
  });
});

// ─── quantizeBuffer ───────────────────────────────────────────────────────────

describe('getBeatSeconds', () => {
  it('returns quarter-note beat length for x/4 signatures', () => {
    expect(getBeatSeconds(120, 4)).toBeCloseTo(0.5);
  });

  it('returns eighth-note beat length for x/8 signatures', () => {
    expect(getBeatSeconds(120, 8)).toBeCloseTo(0.25);
  });
});

describe('quantizeBuffer', () => {
  const ctx = makeMockAudioContext();
  const sampleRate = ctx.sampleRate; // 44100
  const bpm = 120;
  const beatsPerBar = 4;
  // One bar at 120 BPM = 4 beats × 0.5 s = 2 s
  const barSamples = Math.round(2 * sampleRate); // 88200

  function makeBuffer(samples) {
    const data = new Float32Array(samples);
    data.fill(0.5);
    return {
      numberOfChannels: 1,
      length: samples,
      sampleRate,
      duration: samples / sampleRate,
      getChannelData: (ch) => (ch === 0 ? data : new Float32Array(samples)),
    };
  }

  it('snaps a short buffer (< 1 bar) up to exactly 1 bar', () => {
    // 0.8 s ≈ 0.4 bars → rounds to 0 bars → clamps to 1 bar
    const src = makeBuffer(Math.round(0.8 * sampleRate));
    const out = quantizeBuffer(src, { bpm, beatsPerBar, audioContext: ctx });
    expect(out.length).toBe(barSamples);
  });

  it('leaves a buffer that is already exactly 1 bar unchanged in length', () => {
    const src = makeBuffer(barSamples);
    const out = quantizeBuffer(src, { bpm, beatsPerBar, audioContext: ctx });
    expect(out.length).toBe(barSamples);
  });

  it('snaps a 2.6-bar buffer to 3 bars', () => {
    const src = makeBuffer(Math.round(2.6 * 2 * sampleRate)); // 2.6 bars
    const out = quantizeBuffer(src, { bpm, beatsPerBar, audioContext: ctx });
    expect(out.length).toBe(barSamples * 3);
  });

  it('snaps a 1.9-bar buffer to 2 bars', () => {
    const src = makeBuffer(Math.round(1.9 * 2 * sampleRate));
    const out = quantizeBuffer(src, { bpm, beatsPerBar, audioContext: ctx });
    expect(out.length).toBe(barSamples * 2);
  });

  it('preserves existing samples and zero-pads the tail', () => {
    const src = makeBuffer(Math.round(0.5 * sampleRate)); // half bar – rounds to 1 bar
    const out = quantizeBuffer(src, { bpm, beatsPerBar, audioContext: ctx });
    // First half of the output should match the source (all 0.5)
    const outData = out.getChannelData(0);
    const srcLen = src.length;
    expect(outData[0]).toBeCloseTo(0.5);
    expect(outData[srcLen - 1]).toBeCloseTo(0.5);
    // Tail that was zero-padded should be 0
    expect(outData[srcLen]).toBe(0);
  });

  it('uses the beat unit when quantizing compound time signatures', () => {
    const compoundBarSamples = Math.round(1.5 * sampleRate); // 6/8 at 120 BPM = 1.5 s/bar
    const src = makeBuffer(Math.round(1.6 * sampleRate));
    const out = quantizeBuffer(src, {
      bpm,
      beatsPerBar: 6,
      beatUnit: 8,
      audioContext: ctx,
    });
    expect(out.length).toBe(compoundBarSamples);
  });
});

// ─── estimateTempo ────────────────────────────────────────────────────────────

describe('estimateTempo', () => {
  function makePulseBuffer({ bpm = 120, beats = 8, sampleRate = 44100, channels = 1 }) {
    const secondsPerBeat = 60 / bpm;
    const length = Math.round((beats * secondsPerBeat + 0.25) * sampleRate);
    const channelData = Array.from({ length: channels }, () => new Float32Array(length));

    for (let beat = 0; beat < beats; beat++) {
      const start = Math.round(beat * secondsPerBeat * sampleRate);
      const pulseLength = Math.round(sampleRate * 0.02);
      for (let i = 0; i < pulseLength; i++) {
        const idx = start + i;
        if (idx >= length) break;
        const sample = 0.9 * (1 - i / pulseLength);
        for (const data of channelData) data[idx] = sample;
      }
    }

    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (ch) => channelData[ch],
    };
  }

  function expectTempoClose(actual, expected) {
    expect(actual).toBeGreaterThanOrEqual(expected - 2);
    expect(actual).toBeLessThanOrEqual(expected + 2);
  }

  it('detects a 120 BPM pulse train', () => {
    const detected = estimateTempo(makePulseBuffer({ bpm: 120 }));
    expectTempoClose(detected, 120);
  });

  it('detects a slower 90 BPM pulse train', () => {
    const detected = estimateTempo(makePulseBuffer({ bpm: 90, beats: 10 }));
    expectTempoClose(detected, 90);
  });

  it('handles stereo buffers', () => {
    const detected = estimateTempo(makePulseBuffer({ bpm: 140, channels: 2 }));
    expectTempoClose(detected, 140);
  });

  it('returns null for a silent buffer', () => {
    const silent = {
      numberOfChannels: 1,
      length: 44100,
      sampleRate: 44100,
      duration: 1,
      getChannelData: () => new Float32Array(44100),
    };
    expect(estimateTempo(silent)).toBeNull();
  });

  it('returns null for very short buffers', () => {
    const short = {
      numberOfChannels: 1,
      length: 256,
      sampleRate: 44100,
      duration: 256 / 44100,
      getChannelData: () => new Float32Array(256),
    };
    expect(estimateTempo(short)).toBeNull();
  });
});

// ─── offsetBuffer ──────────────────────────────────────────────────────────────

describe('offsetBuffer', () => {
  const ctx = makeMockAudioContext();

  it('returns the original buffer when the offset is zero', () => {
    const samples = new Float32Array([1, 2, 3]);
    const src = {
      numberOfChannels: 1,
      length: 3,
      sampleRate: 1000,
      getChannelData: () => samples,
    };
    expect(offsetBuffer(src, 0, ctx)).toBe(src);
  });

  it('adds silence at the start for a positive delay shift', () => {
    const samples = new Float32Array([1, 2, 3, 4]);
    const src = {
      numberOfChannels: 1,
      length: 4,
      sampleRate: 1000,
      getChannelData: () => samples,
    };
    const out = offsetBuffer(src, 0.002, ctx);
    expect(Array.from(out.getChannelData(0))).toEqual([0, 0, 1, 2]);
  });

  it('trims the start for a negative advance shift and pads the tail with silence', () => {
    const samples = new Float32Array([1, 2, 3, 4]);
    const src = {
      numberOfChannels: 1,
      length: 4,
      sampleRate: 1000,
      getChannelData: () => samples,
    };
    const out = offsetBuffer(src, -0.002, ctx);
    expect(Array.from(out.getChannelData(0))).toEqual([3, 4, 0, 0]);
  });
});

// ─── fitBufferToBars ──────────────────────────────────────────────────────────

describe('fitBufferToBars', () => {
  const ctx = makeMockAudioContext();
  const sampleRate = ctx.sampleRate;
  const bpm = 120;
  const beatsPerBar = 4;
  const barSamples = Math.round(2 * sampleRate);

  function makeBuffer(samples) {
    const data = new Float32Array(samples);
    data.fill(0.25);
    return {
      numberOfChannels: 1,
      length: samples,
      sampleRate,
      duration: samples / sampleRate,
      getChannelData: () => data,
    };
  }

  it('pads a short recording to the requested bar count', () => {
    const src = makeBuffer(Math.round(1.5 * barSamples));
    const out = fitBufferToBars(src, { bars: 2, bpm, beatsPerBar, audioContext: ctx });
    const outData = out.getChannelData(0);

    expect(out.length).toBe(barSamples * 2);
    expect(outData[src.length - 1]).toBeCloseTo(0.25);
    expect(outData[src.length]).toBe(0);
  });

  it('trims a long recording down to the requested bar count', () => {
    const src = makeBuffer(Math.round(2.5 * barSamples));
    const out = fitBufferToBars(src, { bars: 2, bpm, beatsPerBar, audioContext: ctx });

    expect(out.length).toBe(barSamples * 2);
    expect(out.getChannelData(0)[out.length - 1]).toBeCloseTo(0.25);
  });

  it('rejects invalid bar counts', () => {
    const src = makeBuffer(barSamples);

    expect(() => fitBufferToBars(src, {
      bars: 0,
      bpm,
      beatsPerBar,
      audioContext: ctx,
    })).toThrow('bars must be a whole number >= 1, got 0');
  });

  it('rejects fractional bar counts', () => {
    const src = makeBuffer(barSamples);

    expect(() => fitBufferToBars(src, {
      bars: 1.5,
      bpm,
      beatsPerBar,
      audioContext: ctx,
    })).toThrow('bars must be a whole number >= 1, got 1.5');
  });
});

// ─── reverseBuffer ────────────────────────────────────────────────────────────

describe('reverseBuffer', () => {
  const ctx = makeMockAudioContext();

  it('reverses sample order on a single channel', () => {
    const samples = new Float32Array([1, 2, 3, 4, 5]);
    const src = {
      numberOfChannels: 1,
      length: 5,
      sampleRate: 44100,
      getChannelData: () => samples,
    };
    const rev = reverseBuffer(src, ctx);
    const out = rev.getChannelData(0);
    expect(Array.from(out)).toEqual([5, 4, 3, 2, 1]);
  });

  it('reverses both channels of a stereo buffer independently', () => {
    const ch0 = new Float32Array([1, 2, 3]);
    const ch1 = new Float32Array([4, 5, 6]);
    const src = {
      numberOfChannels: 2,
      length: 3,
      sampleRate: 44100,
      getChannelData: (ch) => (ch === 0 ? ch0 : ch1),
    };
    const rev = reverseBuffer(src, ctx);
    expect(Array.from(rev.getChannelData(0))).toEqual([3, 2, 1]);
    expect(Array.from(rev.getChannelData(1))).toEqual([6, 5, 4]);
  });

  it('leaves a palindrome buffer unchanged', () => {
    const samples = new Float32Array([1, 2, 1]);
    const src = {
      numberOfChannels: 1,
      length: 3,
      sampleRate: 44100,
      getChannelData: () => samples,
    };
    const rev = reverseBuffer(src, ctx);
    expect(Array.from(rev.getChannelData(0))).toEqual([1, 2, 1]);
  });

  it('produces a buffer of the same length as the source', () => {
    const samples = new Float32Array(1024);
    const src = {
      numberOfChannels: 1,
      length: 1024,
      sampleRate: 44100,
      getChannelData: () => samples,
    };
    const rev = reverseBuffer(src, ctx);
    expect(rev.length).toBe(1024);
  });

  it('reversing twice restores the original data', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const src = {
      numberOfChannels: 1,
      length: 4,
      sampleRate: 44100,
      getChannelData: () => samples,
    };
    const once = reverseBuffer(src, ctx);
    const twice = reverseBuffer(once, ctx);
    expect(Array.from(twice.getChannelData(0))).toEqual(Array.from(samples));
  });
});

// ─── makeDistortionCurve ──────────────────────────────────────────────────────

describe('makeDistortionCurve', () => {
  it('returns a Float32Array of the requested length', () => {
    const curve = makeDistortionCurve(100, 256);
    expect(curve).toBeInstanceOf(Float32Array);
    expect(curve.length).toBe(256);
  });

  it('uses 256 samples by default', () => {
    const curve = makeDistortionCurve(100);
    expect(curve.length).toBe(256);
  });

  it('maps the centre sample (mid-point) to approximately 0', () => {
    const curve = makeDistortionCurve(100, 257);
    // The centre index maps x ≈ 0, so output should be ≈ 0.
    expect(curve[128]).toBeCloseTo(0, 5);
  });

  it('produces a monotonically increasing curve', () => {
    const curve = makeDistortionCurve(200, 256);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
    }
  });

  it('is bounded within [-1, 1]', () => {
    const curve = makeDistortionCurve(400, 256);
    for (let i = 0; i < curve.length; i++) {
      expect(curve[i]).toBeGreaterThanOrEqual(-1);
      expect(curve[i]).toBeLessThanOrEqual(1);
    }
  });

  it('with amount 0 produces a near-identity (linear) curve', () => {
    const curve = makeDistortionCurve(0, 257);
    // At amount=0 the formula reduces to x (identity), so first ≈ -1, last ≈ 1.
    expect(curve[0]).toBeCloseTo(-1, 5);
    expect(curve[256]).toBeCloseTo(1, 5);
  });
});

// ─── makeReverbIR ─────────────────────────────────────────────────────────────

describe('makeReverbIR', () => {
  const ctx = makeMockAudioContext();

  it('returns an AudioBuffer with 2 channels', () => {
    const ir = makeReverbIR(ctx);
    expect(ir.numberOfChannels).toBe(2);
  });

  it('defaults to approximately 1.5 s of samples', () => {
    const ir = makeReverbIR(ctx);
    expect(ir.length).toBe(Math.floor(ctx.sampleRate * 1.5));
  });

  it('respects a custom duration', () => {
    const ir = makeReverbIR(ctx, { duration: 2.0 });
    expect(ir.length).toBe(Math.floor(ctx.sampleRate * 2.0));
  });

  it('has non-zero samples (the IR is not silent)', () => {
    const ir = makeReverbIR(ctx);
    const data = ir.getChannelData(0);
    const anyNonZero = Array.from(data).some((v) => v !== 0);
    expect(anyNonZero).toBe(true);
  });

  it('the IR decays towards 0 (tail is quieter than the head)', () => {
    const ir = makeReverbIR(ctx, { duration: 1.0 });
    const data = ir.getChannelData(0);
    // Compute RMS of first and last 10 % of the IR.
    const segLen = Math.floor(data.length * 0.1);
    let headRms = 0;
    let tailRms = 0;
    for (let i = 0; i < segLen; i++) headRms += data[i] * data[i];
    for (let i = data.length - segLen; i < data.length; i++) tailRms += data[i] * data[i];
    expect(tailRms).toBeLessThan(headRms);
  });
});

// ─── applyPunchIn ──────────────────────────────────────────────────────────────

describe('applyPunchIn', () => {
  const ctx = makeMockAudioContext(8);
  const bpm = 240;
  const beatsPerBar = 4;

  function makeMonoBuffer(samples) {
    const data = Float32Array.from(samples);
    return {
      numberOfChannels: 1,
      length: data.length,
      sampleRate: 8,
      duration: data.length / 8,
      getChannelData: () => data,
    };
  }

  function readBuffer(buffer) {
    return Array.from(buffer.getChannelData(0), value => Number(value.toFixed(3)));
  }

  it('overdubs only the selected bar range and leaves the rest unchanged', () => {
    const loop = makeMonoBuffer([0, 0, 0, 0, 0.25, 0.25, 0.25, 0.25]);
    const take = makeMonoBuffer([0.5, 0.5, 0.5, 0.5]);

    const out = applyPunchIn(loop, take, {
      startBar: 1,
      endBar: 1,
      bpm,
      beatsPerBar,
      audioContext: ctx,
    });

    expect(readBuffer(out)).toEqual([
      0.5, 0.5, 0.5, 0.5,
      0.25, 0.25, 0.25, 0.25,
    ]);
  });

  it('starts the overdub at the selected later bar', () => {
    const loop = makeMonoBuffer([
      0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const take = makeMonoBuffer([0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);

    const out = applyPunchIn(loop, take, {
      startBar: 2,
      endBar: 2,
      bpm,
      beatsPerBar,
      audioContext: ctx,
    });

    expect(readBuffer(out)).toEqual([
      0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
      0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4,
    ]);
  });

  it('truncates the take when it is longer than the punched range', () => {
    const loop = makeMonoBuffer([
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const take = makeMonoBuffer([
      0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2,
      0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9,
    ]);

    const out = applyPunchIn(loop, take, {
      startBar: 1,
      endBar: 1,
      bpm,
      beatsPerBar,
      audioContext: ctx,
    });

    expect(readBuffer(out)).toEqual([
      0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2,
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('clips mixed samples to the valid audio range', () => {
    const loop = makeMonoBuffer([0.8, -0.8, 0, 0]);
    const take = makeMonoBuffer([0.8, -0.8, 0, 0]);

    const out = applyPunchIn(loop, take, {
      startBar: 1,
      endBar: 1,
      bpm,
      beatsPerBar,
      audioContext: ctx,
    });

    expect(readBuffer(out)).toEqual([1, -1, 0, 0]);
  });
});

// ─── applyLoopEdits ───────────────────────────────────────────────────────────

describe('applyLoopEdits', () => {
  const ctx = makeMockAudioContext(10);

  function makeBuffer(samples, secondChannel) {
    const channels = [new Float32Array(samples)];
    if (secondChannel) channels.push(new Float32Array(secondChannel));
    return {
      numberOfChannels: channels.length,
      length: channels[0].length,
      sampleRate: 10,
      duration: channels[0].length / 10,
      getChannelData: (ch) => channels[ch],
    };
  }

  it('returns a trimmed copy of the selected region', () => {
    const src = makeBuffer([0, 1, 2, 3, 4, 5]);
    const out = applyLoopEdits(src, {
      trimStart: 0.1,
      trimEnd: 0.4,
      audioContext: ctx,
    });
    expect(Array.from(out.getChannelData(0))).toEqual([1, 2, 3]);
  });

  it('applies a fade-in envelope at the new loop start', () => {
    const src = makeBuffer([1, 1, 1, 1, 1]);
    const out = applyLoopEdits(src, {
      fadeIn: 0.2,
      audioContext: ctx,
    });
    expect(Array.from(out.getChannelData(0))).toEqual([0, 0.5, 1, 1, 1]);
  });

  it('applies a fade-out envelope at the new loop end', () => {
    const src = makeBuffer([1, 1, 1, 1, 1]);
    const out = applyLoopEdits(src, {
      fadeOut: 0.2,
      audioContext: ctx,
    });
    expect(Array.from(out.getChannelData(0))).toEqual([1, 1, 1, 0.5, 0]);
  });

  it('applies trims and fades independently on every channel', () => {
    const src = makeBuffer([0, 1, 2, 3], [10, 11, 12, 13]);
    const out = applyLoopEdits(src, {
      trimStart: 0.1,
      trimEnd: 0.4,
      fadeIn: 0.1,
      fadeOut: 0.1,
      audioContext: ctx,
    });
    expect(Array.from(out.getChannelData(0))).toEqual([0, 2, 0]);
    expect(Array.from(out.getChannelData(1))).toEqual([0, 12, 0]);
  });

  it('keeps at least one frame when trims collapse to the same time', () => {
    const src = makeBuffer([7, 8, 9]);
    const out = applyLoopEdits(src, {
      trimStart: 0.2,
      trimEnd: 0.2,
      audioContext: ctx,
    });
    expect(out.length).toBe(1);
    expect(Array.from(out.getChannelData(0))).toEqual([9]);
  });
});

// ─── resampleBuffer / timeStretchBuffer / transformBuffer ────────────────────

describe('independent speed and pitch transforms', () => {
  const ctx = makeMockAudioContext(8000);
  const sampleRate = ctx.sampleRate;

  function makeSineBuffer({ frequency = 220, durationSeconds = 1 } = {}) {
    const length = Math.round(durationSeconds * sampleRate);
    const out = ctx.createBuffer(1, length, sampleRate);
    const data = out.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    }
    return out;
  }

  function countZeroCrossings(buffer) {
    const data = buffer.getChannelData(0);
    let crossings = 0;
    for (let i = 1; i < data.length; i++) {
      if ((data[i - 1] <= 0 && data[i] > 0) || (data[i - 1] >= 0 && data[i] < 0)) {
        crossings++;
      }
    }
    return crossings;
  }

  function crossingDensity(buffer) {
    return countZeroCrossings(buffer) / buffer.length;
  }

  it('resampleBuffer changes duration according to the pitch ratio', () => {
    const src = makeSineBuffer();
    const upOctave = resampleBuffer(src, 2, ctx);
    const downOctave = resampleBuffer(src, 0.5, ctx);

    expect(upOctave.length).toBe(Math.round(src.length / 2));
    expect(downOctave.length).toBe(Math.round(src.length / 0.5));
  });

  it('timeStretchBuffer changes duration without returning silence', () => {
    const src = makeSineBuffer();
    const stretched = timeStretchBuffer(src, 1.5, ctx);
    const compressed = timeStretchBuffer(src, 0.5, ctx);

    expect(stretched.length).toBe(Math.round(src.length * 1.5));
    expect(compressed.length).toBe(Math.round(src.length * 0.5));
    expect(stretched.getChannelData(0).some((sample) => Math.abs(sample) > 0.01)).toBe(true);
    expect(compressed.getChannelData(0).some((sample) => Math.abs(sample) > 0.01)).toBe(true);
  });

  it('transformBuffer can raise pitch while keeping the original duration', () => {
    const src = makeSineBuffer();
    const shifted = transformBuffer(src, {
      speed: 1,
      pitchSemitones: 12,
      audioContext: ctx,
    });

    expect(shifted.length).toBeCloseTo(src.length, -2);
    expect(countZeroCrossings(shifted)).toBeGreaterThan(countZeroCrossings(src) * 1.6);
  });

  it('transformBuffer can change speed while roughly preserving pitch', () => {
    const src = makeSineBuffer();
    const faster = transformBuffer(src, {
      speed: 2,
      pitchSemitones: 0,
      audioContext: ctx,
    });

    expect(faster.length).toBeCloseTo(src.length / 2, -2);
    expect(crossingDensity(faster)).toBeGreaterThan(crossingDensity(src) * 0.7);
    expect(crossingDensity(faster)).toBeLessThan(crossingDensity(src) * 1.3);
  });
});

// ─── createBuiltinSampleLoop ──────────────────────────────────────────────────

describe('createBuiltinSampleLoop', () => {
  it('creates a one-bar loop using the current BPM and beats per bar', () => {
    const audioContext = makeMockAudioContext(48000);
    const buffer = createBuiltinSampleLoop(audioContext, {
      sample: 'kick',
      bpm: 120,
      beatsPerBar: 4,
    });

    expect(buffer.sampleRate).toBe(48000);
    expect(buffer.length).toBe(96000);
    expect(buffer.duration).toBe(2);
  });

  it('produces audible data for each built-in sample type', () => {
    const audioContext = makeMockAudioContext(44100);

    for (const sample of ['kick', 'snare', 'clap']) {
      const buffer = createBuiltinSampleLoop(audioContext, {
        sample,
        bpm: 100,
        beatsPerBar: 4,
      });
      const peak = buffer.getChannelData(0).reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      expect(peak).toBeGreaterThan(0.05);
    }
  });

  it('throws for an unknown built-in sample', () => {
    const audioContext = makeMockAudioContext();

    expect(() => createBuiltinSampleLoop(audioContext, {
      sample: 'cowbell',
      bpm: 100,
      beatsPerBar: 4,
    })).toThrow('Unknown built-in sample: cowbell');
  });
});

// ─── shared-session packing ───────────────────────────────────────────────────

describe('packSharedSession / unpackSharedSession', () => {
  it('round-trips mixer state and loop audio bytes', () => {
    const session = {
      bpm: 128,
      beatsPerBar: 3,
      masterVolume: 0.85,
      loops: [
        {
          name: 'Bass',
          volume: 0.75,
          pan: -0.2,
          playbackRate: 1.1,
          muted: false,
          soloed: true,
          reversed: true,
          mimeType: 'audio/webm',
          audioBytes: new Uint8Array([1, 2, 3, 4]),
        },
        {
          name: 'Lead',
          volume: 1.2,
          pan: 0.4,
          playbackRate: 0.9,
          muted: true,
          soloed: false,
          reversed: false,
          mimeType: 'audio/ogg',
          audioBytes: new Uint8Array([9, 8, 7]),
        },
      ],
    };

    const packed = packSharedSession(session);
    const unpacked = unpackSharedSession(packed);

    expect(unpacked.bpm).toBe(128);
    expect(unpacked.beatsPerBar).toBe(3);
    expect(unpacked.masterVolume).toBe(0.85);
    expect(unpacked.loops).toHaveLength(2);
    expect(unpacked.loops[0]).toMatchObject({
      name: 'Bass',
      volume: 0.75,
      pan: -0.2,
      playbackRate: 1.1,
      muted: false,
      soloed: true,
      reversed: true,
      mimeType: 'audio/webm',
    });
    expect(Array.from(unpacked.loops[0].audioBytes)).toEqual([1, 2, 3, 4]);
    expect(Array.from(unpacked.loops[1].audioBytes)).toEqual([9, 8, 7]);
  });

  it('rejects truncated payloads', () => {
    expect(() => unpackSharedSession('AQID')).toThrow(/truncated/i);
  });

  it('rejects unsupported versions', () => {
    const manifest = new TextEncoder().encode(JSON.stringify({ v: 2, l: [] }));
    const out = new Uint8Array(4 + manifest.length);
    new DataView(out.buffer).setUint32(0, manifest.length, true);
    out.set(manifest, 4);
    const packed = Buffer.from(out)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    expect(() => unpackSharedSession(packed)).toThrow(/not supported/i);
  });
});
