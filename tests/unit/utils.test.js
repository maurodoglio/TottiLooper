/**
 * Unit tests for src/utils.js.
 *
 * All pure-function logic is tested here in a plain Node environment – no
 * browser, no jsdom, no mocking of DOM globals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDuration,
  panText,
  writeString,
  audioBufferToWav,
  getSupportedMimeType,
  effectiveGain,
  getBeatSeconds,
  getBarSeconds,
  quantizeBuffer,
  reverseBuffer,
  applyFadeIn,
  applyFadeOut,
  UndoStack,
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

// ─── getBeatSeconds ───────────────────────────────────────────────────────────

describe('getBeatSeconds', () => {
  it('returns 0.5 s per beat at 120 BPM', () => {
    expect(getBeatSeconds(120)).toBeCloseTo(0.5);
  });

  it('returns 1 s per beat at 60 BPM', () => {
    expect(getBeatSeconds(60)).toBeCloseTo(1);
  });

  it('returns 0.25 s per beat at 240 BPM', () => {
    expect(getBeatSeconds(240)).toBeCloseTo(0.25);
  });

  it('returns the exact value 60/bpm for arbitrary BPM', () => {
    expect(getBeatSeconds(90)).toBeCloseTo(60 / 90);
    expect(getBeatSeconds(72)).toBeCloseTo(60 / 72);
  });
});

// ─── getBarSeconds ────────────────────────────────────────────────────────────

describe('getBarSeconds', () => {
  it('returns 2 s per bar at 120 BPM with 4 beats per bar', () => {
    expect(getBarSeconds(120, 4)).toBeCloseTo(2);
  });

  it('returns 1 s per bar at 120 BPM with 2 beats per bar', () => {
    expect(getBarSeconds(120, 2)).toBeCloseTo(1);
  });

  it('returns 3 s per bar at 60 BPM with 3 beats per bar (3/4 time)', () => {
    expect(getBarSeconds(60, 3)).toBeCloseTo(3);
  });

  it('scales linearly with beatsPerBar', () => {
    const bpm = 100;
    const beat = getBeatSeconds(bpm);
    expect(getBarSeconds(bpm, 6)).toBeCloseTo(beat * 6);
    expect(getBarSeconds(bpm, 7)).toBeCloseTo(beat * 7);
  });
});

// ─── applyFadeIn ──────────────────────────────────────────────────────────────

describe('applyFadeIn', () => {
  const ctx = makeMockAudioContext();

  function makeBuffer(samples) {
    const data = new Float32Array(samples.length);
    data.set(samples);
    return {
      numberOfChannels: 1,
      length: samples.length,
      sampleRate: 44100,
      getChannelData: (ch) => (ch === 0 ? data : new Float32Array(samples.length)),
    };
  }

  it('returns the original buffer when fadeSamples is 0', () => {
    const src = makeBuffer(new Float32Array([1, 1, 1, 1]));
    expect(applyFadeIn(src, 0, ctx)).toBe(src);
  });

  it('ramps the first N samples from 0 to 1', () => {
    // 4 samples at constant amplitude 1; fade the first 4
    const src = makeBuffer(new Float32Array([1, 1, 1, 1]));
    const out = applyFadeIn(src, 4, ctx);
    const d = out.getChannelData(0);
    // sample i gets factor i/4
    expect(d[0]).toBeCloseTo(0);        // 1 * 0/4
    expect(d[1]).toBeCloseTo(0.25);     // 1 * 1/4
    expect(d[2]).toBeCloseTo(0.5);      // 1 * 2/4
    expect(d[3]).toBeCloseTo(0.75);     // 1 * 3/4
  });

  it('leaves samples after the fade region unchanged', () => {
    const src = makeBuffer(new Float32Array([1, 1, 1, 1, 1, 1]));
    const out = applyFadeIn(src, 3, ctx);
    const d = out.getChannelData(0);
    expect(d[3]).toBeCloseTo(1);
    expect(d[4]).toBeCloseTo(1);
    expect(d[5]).toBeCloseTo(1);
  });

  it('clamps fadeSamples to the buffer length when it exceeds buffer size', () => {
    const src = makeBuffer(new Float32Array([1, 1, 1]));
    // 100 > 3, so the ramp spans all 3 samples
    const out = applyFadeIn(src, 100, ctx);
    const d = out.getChannelData(0);
    expect(d[0]).toBeCloseTo(0);       // 1 * 0/3
    expect(d[1]).toBeCloseTo(1 / 3);   // 1 * 1/3
    expect(d[2]).toBeCloseTo(2 / 3);   // 1 * 2/3
  });

  it('produces a buffer of the same length as the source', () => {
    const src = makeBuffer(new Float32Array(100));
    const out = applyFadeIn(src, 50, ctx);
    expect(out.length).toBe(100);
  });
});

// ─── applyFadeOut ─────────────────────────────────────────────────────────────

describe('applyFadeOut', () => {
  const ctx = makeMockAudioContext();

  function makeBuffer(samples) {
    const data = new Float32Array(samples.length);
    data.set(samples);
    return {
      numberOfChannels: 1,
      length: samples.length,
      sampleRate: 44100,
      getChannelData: (ch) => (ch === 0 ? data : new Float32Array(samples.length)),
    };
  }

  it('returns the original buffer when fadeSamples is 0', () => {
    const src = makeBuffer(new Float32Array([1, 1, 1, 1]));
    expect(applyFadeOut(src, 0, ctx)).toBe(src);
  });

  it('ramps the last N samples from 1 to 0', () => {
    const src = makeBuffer(new Float32Array([1, 1, 1, 1]));
    const out = applyFadeOut(src, 4, ctx);
    const d = out.getChannelData(0);
    // sample at index i within fade region gets factor (1 - i/4)
    expect(d[0]).toBeCloseTo(1);        // 1 * (1 - 0/4)
    expect(d[1]).toBeCloseTo(0.75);     // 1 * (1 - 1/4)
    expect(d[2]).toBeCloseTo(0.5);      // 1 * (1 - 2/4)
    expect(d[3]).toBeCloseTo(0.25);     // 1 * (1 - 3/4)
  });

  it('leaves samples before the fade region unchanged', () => {
    const src = makeBuffer(new Float32Array([1, 1, 1, 1, 1, 1]));
    const out = applyFadeOut(src, 3, ctx);
    const d = out.getChannelData(0);
    expect(d[0]).toBeCloseTo(1);
    expect(d[1]).toBeCloseTo(1);
    expect(d[2]).toBeCloseTo(1);
  });

  it('clamps fadeSamples to the buffer length when it exceeds buffer size', () => {
    const src = makeBuffer(new Float32Array([1, 1, 1]));
    const out = applyFadeOut(src, 100, ctx);
    const d = out.getChannelData(0);
    expect(d[0]).toBeCloseTo(1);        // 1 * (1 - 0/3)
    expect(d[1]).toBeCloseTo(2 / 3);    // 1 * (1 - 1/3)
    expect(d[2]).toBeCloseTo(1 / 3);    // 1 * (1 - 2/3)
  });

  it('produces a buffer of the same length as the source', () => {
    const src = makeBuffer(new Float32Array(100));
    const out = applyFadeOut(src, 50, ctx);
    expect(out.length).toBe(100);
  });

  it('applying fade-in then fade-out to a constant signal produces a bell-shaped envelope', () => {
    // 4-sample buffer; fade-in and fade-out each span all 4 samples so they
    // overlap and produce a symmetric (bell-shaped) amplitude curve.
    const data = new Float32Array(4).fill(1);
    const src = makeBuffer(data);
    const faded = applyFadeOut(applyFadeIn(src, 4, ctx), 4, ctx);
    const d = faded.getChannelData(0);
    // The combined gain at index i is (i/4) * (1 - i/4), peaking at i=2
    expect(d[0]).toBeCloseTo(0);        // 0 * 1   = 0
    expect(d[1]).toBeCloseTo(3 / 16);   // 0.25 * 0.75
    expect(d[2]).toBeCloseTo(1 / 4);    // 0.5  * 0.5  (peak)
    expect(d[3]).toBeCloseTo(3 / 16);   // 0.75 * 0.25
  });
});

// ─── UndoStack ────────────────────────────────────────────────────────────────

describe('UndoStack', () => {
  it('starts empty with size 0 and canUndo false', () => {
    const stack = new UndoStack(10);
    expect(stack.size).toBe(0);
    expect(stack.canUndo).toBe(false);
  });

  it('increases size on push', () => {
    const stack = new UndoStack(10);
    stack.push('a');
    expect(stack.size).toBe(1);
    expect(stack.canUndo).toBe(true);
  });

  it('returns the last pushed item on pop (LIFO order)', () => {
    const stack = new UndoStack(10);
    stack.push('first');
    stack.push('second');
    expect(stack.pop()).toBe('second');
    expect(stack.pop()).toBe('first');
  });

  it('returns null when popping an empty stack', () => {
    const stack = new UndoStack(10);
    expect(stack.pop()).toBeNull();
  });

  it('enforces the maxSize cap by dropping the oldest item', () => {
    const stack = new UndoStack(3);
    stack.push('a');
    stack.push('b');
    stack.push('c');
    stack.push('d'); // 'a' should be dropped
    expect(stack.size).toBe(3);
    // The remaining items should be b, c, d in order
    expect(stack.pop()).toBe('d');
    expect(stack.pop()).toBe('c');
    expect(stack.pop()).toBe('b');
  });

  it('never exceeds maxSize regardless of how many items are pushed', () => {
    const stack = new UndoStack(5);
    for (let i = 0; i < 20; i++) stack.push(i);
    expect(stack.size).toBe(5);
  });

  it('clamps maxSize to at least 1 when constructed with 0', () => {
    const stack = new UndoStack(0);
    stack.push('x');
    expect(stack.size).toBe(1);
    // The effective maxSize is 1, so a second push should evict the first
    stack.push('y');
    expect(stack.size).toBe(1);
    expect(stack.pop()).toBe('y');
  });

  it('clear empties the stack', () => {
    const stack = new UndoStack(10);
    stack.push(1);
    stack.push(2);
    stack.clear();
    expect(stack.size).toBe(0);
    expect(stack.canUndo).toBe(false);
  });

  it('can store and retrieve arbitrary objects', () => {
    const stack = new UndoStack(5);
    const obj = { id: 1, name: 'loop', playing: false };
    stack.push(obj);
    expect(stack.pop()).toBe(obj);
  });
});
