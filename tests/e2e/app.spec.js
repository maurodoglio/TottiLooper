/**
 * End-to-end tests for TottiLooper.
 *
 * The Playwright config starts a static file server and launches Chromium with
 * `--use-fake-device-for-media-stream` + `--use-fake-ui-for-media-stream` so
 * that the microphone permission dialog is auto-accepted and all recording uses
 * a synthetic audio signal — no real microphone required.
 */

import { test, expect } from '@playwright/test';

async function installSyntheticDecode(page) {
  await page.addInitScript(() => {
    globalThis.__testDecodeMidis = [60, 62, 64, 65, 67, 69, 71, 72];

    const frequencyForMidi = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
    const decodeAudioData = async function decodeAudioData() {
      const sampleRate = this.sampleRate || 44100;
      const noteDuration = 0.12;
      const samplesPerNote = Math.floor(sampleRate * noteDuration);
      const totalSamples = samplesPerNote * globalThis.__testDecodeMidis.length;
      const buffer = this.createBuffer(1, totalSamples, sampleRate);
      const data = buffer.getChannelData(0);

      globalThis.__testDecodeMidis.forEach((midi, noteIndex) => {
        const freq = frequencyForMidi(midi);
        const start = noteIndex * samplesPerNote;
        for (let i = 0; i < samplesPerNote; i++) {
          const t = i / sampleRate;
          const fade = Math.min(1, i / 256, (samplesPerNote - i) / 256);
          data[start + i] = Math.sin(2 * Math.PI * freq * t) * 0.5 * fade;
        }
      });

      return buffer;
    };

    if (globalThis.AudioContext) {
      globalThis.AudioContext.prototype.decodeAudioData = decodeAudioData;
    }
    if (globalThis.webkitAudioContext) {
      globalThis.webkitAudioContext.prototype.decodeAudioData = decodeAudioData;
    }
  });
}

async function mockDetectedTempo(page, bpm = 120) {
  await page.addInitScript((detectedBpm) => {
    const makeTempoBuffer = () => {
      const sampleRate = 44100;
      const secondsPerBeat = 60 / detectedBpm;
      const beats = 8;
      const length = Math.round((beats * secondsPerBeat + 0.25) * sampleRate);
      const data = new Float32Array(length);

      for (let beat = 0; beat < beats; beat++) {
        const start = Math.round(beat * secondsPerBeat * sampleRate);
        const pulseLength = Math.round(sampleRate * 0.02);
        for (let i = 0; i < pulseLength; i++) {
          const idx = start + i;
          if (idx >= length) break;
          data[idx] = 0.9 * (1 - i / pulseLength);
        }
      }

      return {
        numberOfChannels: 1,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => data,
      };
    };

    const patchDecodeAudioData = (Ctor) => {
      if (!Ctor || !Ctor.prototype) return;
      Ctor.prototype.decodeAudioData = async () => makeTempoBuffer();
    };

    patchDecodeAudioData(globalThis.AudioContext);
    patchDecodeAudioData(globalThis.webkitAudioContext);
  }, bpm);
}

async function recordFirstLoop(page) {
  await page.click('#btn-record');
  await expect(page.locator('#record-timer')).toHaveText('0:01', { timeout: 3000 });
  await page.click('#btn-record');
}

async function setRangeValue(locator, value) {
  await locator.evaluate((el, nextValue) => {
    el.value = String(nextValue);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function expectContrastRatioAtLeast(locator, minimumRatio) {
  await expect
    .poll(async () => locator.evaluate((el) => {
      const toRgb = (value) => (value.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
      const toLinear = (channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]) =>
        0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
      const contrast = (a, b) => {
        const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (lighter + 0.05) / (darker + 0.05);
      };

      const styles = globalThis.getComputedStyle(el);
      return contrast(toRgb(styles.color), toRgb(styles.backgroundColor));
    }))
    .toBeGreaterThanOrEqual(minimumRatio);
}

async function recordShortLoop(page) {
  await page.click('#btn-record');
  await page.waitForTimeout(600);
  await page.click('#btn-record');
}

function deleteLoopButton(page) {
  return page.getByRole('button', { name: 'Delete loop' });
}

async function installGamepadStub(page) {
  await page.addInitScript(() => {
    const state = {
      buttons: Array.from({ length: 4 }, () => ({ pressed: false, touched: false, value: 0 })),
    };

    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [{
        index: 0,
        id: 'Test Foot Switch',
        connected: true,
        mapping: 'standard',
        axes: [],
        buttons: state.buttons.map((button) => ({ ...button })),
      }],
    });

    globalThis.__setGamepadButton = (buttonIndex, pressed) => {
      state.buttons[buttonIndex] = {
        pressed,
        touched: pressed,
        value: pressed ? 1 : 0,
      };
    };
  });
}

async function installFakeMidi(page) {
  await page.addInitScript(() => {
    const input = {
      id: 'fake-midi-1',
      name: 'Fake MIDI Controller',
      manufacturer: 'Playwright',
      onmidimessage: null,
    };
    const access = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map(),
      onstatechange: null,
      addEventListener(type, handler) {
        if (type === 'statechange') this.onstatechange = handler;
      },
    };

    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => access,
    });

    globalThis.__dispatchMidi = (data) => {
      input.onmidimessage?.({ data: new Uint8Array(data), target: input });
    };
  });
}

async function pressGamepadButton(page, buttonIndex) {
  await page.evaluate((idx) => globalThis.__setGamepadButton(idx, true), buttonIndex);
  await page.waitForTimeout(100);
  await page.evaluate((idx) => globalThis.__setGamepadButton(idx, false), buttonIndex);
  await page.waitForTimeout(100);
}

// ─── Initial page state ───────────────────────────────────────────────────────

test.describe('initial state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows the app title', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('TottiLooper');
  });

  test('shows the permission banner', async ({ page }) => {
    await expect(page.locator('#permission-banner')).toBeVisible();
  });

  test('hides recording controls before mic is granted', async ({ page }) => {
    await expect(page.locator('#record-controls')).not.toBeVisible();
  });

  test('shows the built-in sample library', async ({ page }) => {
    await expect(page.locator('#sample-library')).toBeVisible();
    await expect(page.locator('[data-builtin-sample="kick"]')).toBeVisible();
    await expect(page.locator('[data-builtin-sample="snare"]')).toBeVisible();
    await expect(page.locator('[data-builtin-sample="clap"]')).toBeVisible();
  });

  test('hides tempo controls before mic is granted', async ({ page }) => {
    await expect(page.locator('#tempo-controls')).not.toBeVisible();
  });

  test('hides input controls before mic is granted', async ({ page }) => {
    await expect(page.locator('#input-controls')).not.toBeVisible();
  });

  test('hides master controls before mic is granted', async ({ page }) => {
    await expect(page.locator('#master-controls')).not.toBeVisible();
  });

  test('BPM input defaults to 100', async ({ page }) => {
    await expect(page.locator('#bpm-input')).toHaveValue('100');
  });

  test('beats-per-bar input defaults to 4', async ({ page }) => {
    await expect(page.locator('#beats-per-bar-input')).toHaveValue('4');
  });

  test('metronome subdivision defaults to quarter notes', async ({ page }) => {
    await expect(page.locator('#metronome-subdivision-input')).toHaveValue('1');
  });
});

// ─── Theme toggle ──────────────────────────────────────────────────────────────

test.describe('theme toggle', () => {
  test('defaults to light theme when the system prefers light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#btn-theme-toggle')).toHaveAttribute('aria-label', 'Switch to dark theme');
  });

  test('defaults to dark theme when the system prefers dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#btn-theme-toggle')).toHaveAttribute('aria-label', 'Switch to light theme');
  });

  test('persists the selected theme across reloads', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');

    await page.click('#btn-theme-toggle');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('tottilooper-theme'))).toBe('dark');

    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#btn-theme-toggle')).toHaveAttribute('aria-label', 'Switch to light theme');
  });
});

// ─── Help modal ───────────────────────────────────────────────────────────────

test.describe('help modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('is hidden on page load', async ({ page }) => {
    await expect(page.locator('#help-modal')).toBeHidden();
  });

  test('opens when the ? button is clicked', async ({ page }) => {
    await page.click('#btn-help');
    await expect(page.locator('#help-modal')).toBeVisible();
  });

  test('closes when the ✕ button is clicked', async ({ page }) => {
    await page.click('#btn-help');
    await page.click('#help-close');
    await expect(page.locator('#help-modal')).toBeHidden();
  });

  test('closes when the Escape key is pressed', async ({ page }) => {
    await page.click('#btn-help');
    await expect(page.locator('#help-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#help-modal')).toBeHidden();
  });

  test('closes when clicking the overlay outside the card', async ({ page }) => {
    await page.click('#btn-help');
    await expect(page.locator('#help-modal')).toBeVisible();
    // Click a corner of the overlay, well outside the help card.
    await page.locator('#help-modal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#help-modal')).toBeHidden();
  });

  test('opens via the ? keyboard shortcut', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(page.locator('#help-modal')).toBeVisible();
  });

  test('contains usage instructions', async ({ page }) => {
    await page.click('#btn-help');
    await expect(page.locator('#help-modal')).toContainText('Getting started');
    await expect(page.locator('#help-modal')).toContainText('Keyboard shortcuts');
  });

  test('persists remapped help shortcut in localStorage', async ({ page }) => {
    await page.click('#btn-help');
    await page.locator('input[aria-label="Open help shortcut"]').click();
    await page.keyboard.press('h');
    await expect(page.locator('input[aria-label="Open help shortcut"]')).toHaveValue('H');
    await page.click('#help-close');

    await page.keyboard.press('?');
    await expect(page.locator('#help-modal')).toBeHidden();

    await page.keyboard.press('h');
    await expect(page.locator('#help-modal')).toBeVisible();

    await page.reload();
    await expect(page.locator('#help-modal')).toBeHidden();
    await page.keyboard.press('h');
    await expect(page.locator('#help-modal')).toBeVisible();
  });
});

// ─── After microphone access ──────────────────────────────────────────────────

test.describe('after microphone access', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-request-mic');
    // Wait for the UI to transition (AudioContext setup is async).
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });
  });

  test('hides the permission banner', async ({ page }) => {
    await expect(page.locator('#permission-banner')).toBeHidden();
  });

  test('shows the recording controls', async ({ page }) => {
    await expect(page.locator('#record-controls')).toBeVisible();
  });

  test('shows the tempo controls', async ({ page }) => {
    await expect(page.locator('#tempo-controls')).toBeVisible();
  });

  test('shows the input controls', async ({ page }) => {
    await expect(page.locator('#input-controls')).toBeVisible();
  });

  test('shows the master controls', async ({ page }) => {
    await expect(page.locator('#master-controls')).toBeVisible();
  });

  test('shows the drum generator controls', async ({ page }) => {
    await expect(page.locator('#drum-controls')).toBeVisible();
    await expect(page.locator('#drum-style')).toHaveValue('rock');
  });

  test('shows the loops section', async ({ page }) => {
    await expect(page.locator('#loops-section')).toBeVisible();
  });

  test('shows the empty-state placeholder', async ({ page }) => {
    await expect(page.locator('#empty-state')).toBeVisible();
  });

  test('undo button is disabled (no deletions yet)', async ({ page }) => {
    await expect(page.locator('#btn-undo')).toBeDisabled();
  });

  test('redo and clear-all buttons are disabled with no loops', async ({ page }) => {
    await expect(page.locator('#btn-redo')).toBeDisabled();
    await expect(page.locator('#btn-clear-all')).toBeDisabled();
  });

  test('master volume slider defaults to 1', async ({ page }) => {
    await expect(page.locator('#master-volume')).toHaveValue('1');
  });

  test('master volume slider exposes value text with units', async ({ page }) => {
    const slider = page.locator('#master-volume');

    await expect(slider).toHaveAttribute('aria-valuetext', '100 percent');

    await setRangeValue(slider, '1.25');

    await expect(slider).toHaveAttribute('aria-valuetext', '125 percent');
  });

  test('now-playing indicator starts idle', async ({ page }) => {
    await expect(page.locator('#playback-position')).toHaveText('Now playing: —');
  });

  test('MIDI click export toggle is available', async ({ page }) => {
    await expect(page.locator('#export-midi-toggle')).toBeVisible();
  });

  test('status text shows ready message', async ({ page }) => {
    await expect(page.locator('#status-text')).toContainText('Ready');
  });

  test('can generate a drum loop from the selected style', async ({ page }) => {
    await page.selectOption('#drum-style', 'funk');
    await page.click('#btn-generate-drums');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.loop-name')).toHaveValue('Funk Drums · 100 BPM');
  });

  test('primary controls meet text contrast requirements', async ({ page }) => {
    await expectContrastRatioAtLeast(page.locator('#btn-record'), 4.5);
    await expectContrastRatioAtLeast(page.locator('#btn-play-all'), 4.5);

    await page.click('#btn-record');
    await expectContrastRatioAtLeast(page.locator('#btn-record'), 4.5);
  });

  test('populates the input device and channel selectors', async ({ page }) => {
    await expect(page.locator('#input-device-select')).toHaveValue(/.+/);
    await expect(page.locator('#input-channel-select')).toHaveValue('all');
    await expect.poll(async () => {
      return page.locator('#input-channel-select option').count();
    }).toBeGreaterThanOrEqual(2);
  });

  test('input monitoring defaults to off with latency offset disabled', async ({ page }) => {
    await expect(page.locator('#monitoring-toggle')).not.toBeChecked();
    await expect(page.locator('#monitor-latency-offset')).toHaveValue('0');
    await expect(page.locator('#monitor-latency-offset')).toBeDisabled();
  });

  test('enabling input monitoring enables the latency offset control', async ({ page }) => {
    await page.locator('#monitoring-toggle').check();
    await expect(page.locator('#monitoring-toggle')).toBeChecked();
    await expect(page.locator('#monitor-latency-offset')).toBeEnabled();
  });

  test('latency offset can be adjusted while monitoring is enabled', async ({ page }) => {
    await page.locator('#monitoring-toggle').check();
    await page.locator('#monitor-latency-offset').fill('-25');
    await expect(page.locator('#monitor-latency-offset')).toHaveValue('-25');
  });
});

// ─── Built-in sample library ──────────────────────────────────────────────────

test.describe('built-in sample library', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('adds a kick loop without microphone access', async ({ page }) => {
    await page.click('[data-builtin-sample="kick"]');

    await expect(page.locator('#tempo-controls')).toBeVisible();
    await expect(page.locator('#master-controls')).toBeVisible();
    await expect(page.locator('#loops-section')).toBeVisible();
    await expect(page.locator('#record-controls')).not.toBeVisible();
    await expect(page.locator('.loop-card')).toBeVisible();
    await expect(page.locator('.loop-name')).toHaveValue('Kick');
  });

  test('can layer multiple built-in samples into a basic drum pattern', async ({ page }) => {
    await page.click('[data-builtin-sample="kick"]');
    await page.click('[data-builtin-sample="snare"]');
    await page.click('[data-builtin-sample="clap"]');

    await expect(page.locator('.loop-card')).toHaveCount(3);
    await expect(page.locator('.loop-name').nth(0)).toHaveValue('Kick');
    await expect(page.locator('.loop-name').nth(1)).toHaveValue('Snare');
    await expect(page.locator('.loop-name').nth(2)).toHaveValue('Clap');
  });
});

// ─── Recording flow ───────────────────────────────────────────────────────────

test.describe('recording flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('#btn-request-mic');
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });
  });

  test('REC button changes label to STOP when recording starts', async ({ page }) => {
    await page.click('#btn-record');
    await expect(page.locator('#btn-record')).toContainText('STOP');
  });

  test('status text updates to Recording… when recording', async ({ page }) => {
    await page.click('#btn-record');
    await expect(page.locator('#status-text')).toContainText('Recording');
  });

  test('DISCARD button is enabled while recording', async ({ page }) => {
    await page.click('#btn-record');
    await expect(page.locator('#btn-stop-record')).toBeEnabled();
  });

  test('DISCARD button is disabled when not recording', async ({ page }) => {
    await expect(page.locator('#btn-stop-record')).toBeDisabled();
  });

  test('recording can be stopped and a loop card appears', async ({ page }) => {
    await page.click('#btn-record');
    // Record for a short moment using the fake audio device.
    await page.waitForTimeout(600);
    await page.click('#btn-record'); // stop
    // Wait for the loop to be decoded and rendered.
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
  });

  test('empty state disappears after the first loop is recorded', async ({ page }) => {
    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#empty-state')).toBeHidden();
  });

  test('discard clears the recording and resets the button', async ({ page }) => {
    await page.click('#btn-record');
    await page.waitForTimeout(300);
    await page.click('#btn-stop-record'); // discard
    await expect(page.locator('#btn-record')).toContainText('REC');
    await expect(page.locator('#btn-stop-record')).toBeDisabled();
    // No loop card should appear after discard.
    await page.waitForTimeout(500);
    await expect(page.locator('.loop-card')).not.toBeVisible();
  });

  test('Space key starts and stops recording', async ({ page }) => {
    await page.keyboard.press('Space');
    await expect(page.locator('#btn-record')).toContainText('STOP');
    await page.waitForTimeout(600);
    await page.keyboard.press('Space');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
  });

  test('uses a remapped record shortcut', async ({ page }) => {
    await page.click('#btn-help');
    await page.locator('input[aria-label="Start / stop recording shortcut"]').click();
    await page.keyboard.press('r');
    await page.click('#help-close');

    await page.keyboard.press('Space');
    await expect(page.locator('#btn-record')).toContainText('REC');

    await page.keyboard.press('r');
    await expect(page.locator('#btn-record')).toContainText('STOP');
  });
});

// ─── Key detection ─────────────────────────────────────────────────────────────

test.describe('key detection', () => {
  test.beforeEach(async ({ page }) => {
    await installSyntheticDecode(page);
    await page.goto('/');
    await page.click('#btn-request-mic');
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });
  });

  test('shows the detected key on a recorded loop', async ({ page }) => {
    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.loop-key')).toHaveText('C major');
    await expect(page.locator('#status-text')).toContainText('Detected key: C major');
  });

  test('warns when a new loop appears to clash with existing loops', async ({ page }) => {
    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });

    await page.evaluate(() => {
      // E major scale
      globalThis.__testDecodeMidis = [64, 66, 68, 69, 71, 73, 75, 76];
    });

    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toHaveCount(2, { timeout: 8000 });
    await expect(page.locator('#error-toast')).toContainText('may clash');
    await expect(page.locator('.loop-key').nth(1)).toHaveText('E major');
  });
});

// ─── Loop controls ────────────────────────────────────────────────────────────

test.describe('loop controls', () => {
  async function getPlayheadLeftPercent(page) {
    return page.locator('.loop-playhead').evaluate((el) => parseFloat(el.style.left || '0'));
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-request-mic');
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });
    // Record one short loop.
    await recordShortLoop(page);
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
  });

  test('loop card has a name input defaulting to Loop 1', async ({ page }) => {
    await expect(page.locator('.loop-name')).toHaveValue('Loop 1');
  });

  test('loop name can be changed', async ({ page }) => {
    await page.locator('.loop-name').fill('Bass');
    await page.locator('.loop-name').press('Enter');
    await expect(page.locator('.loop-name')).toHaveValue('Bass');
  });

  test('loop card shows the duration', async ({ page }) => {
    await expect(page.locator('.loop-duration')).toBeVisible();
  });

  test('loop trim handles can shorten the waveform selection', async ({ page }) => {
    const duration = page.locator('.loop-duration');
    const before = await duration.getAttribute('title');
    const handle = page.getByRole('slider', { name: 'Trim end' });
    await handle.focus();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('ArrowLeft');
    }

    await expect(duration).not.toHaveAttribute('title', before);
  });

  test('fade sliders can be adjusted after recording', async ({ page }) => {
    await page.getByLabel('Fade In').evaluate((el) => {
      el.value = '0.12';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('.fader').filter({ hasText: 'Fade In' })).toContainText('120ms');
  });

  test('half-time and double-time toggles update the speed control', async ({ page }) => {
    const speedSlider = page.locator('input[aria-label="Loop speed"]');
    const halfTimeButton = page.locator('.btn-half-time');
    const doubleTimeButton = page.locator('.btn-double-time');

    await halfTimeButton.click();
    await expect(halfTimeButton).toHaveAttribute('aria-pressed', 'true');
    await expect(doubleTimeButton).toHaveAttribute('aria-pressed', 'false');
    await expect(speedSlider).toHaveValue('0.5');

    await halfTimeButton.click();
    await expect(halfTimeButton).toHaveAttribute('aria-pressed', 'false');
    await expect(speedSlider).toHaveValue('1');

    await doubleTimeButton.click();
    await expect(doubleTimeButton).toHaveAttribute('aria-pressed', 'true');
    await expect(halfTimeButton).toHaveAttribute('aria-pressed', 'false');
    await expect(speedSlider).toHaveValue('2');
  });

  test('loop card exposes 3-band EQ controls with neutral defaults', async ({ page }) => {
    await expect(page.locator('input[aria-label="Loop low EQ"]')).toHaveValue('0');
    await expect(page.locator('input[aria-label="Loop mid EQ"]')).toHaveValue('0');
    await expect(page.locator('input[aria-label="Loop high EQ"]')).toHaveValue('0');

    await expect(
      page.locator('.fader[data-fader="low"] .fader-value'),
    ).toHaveText('0dB');
    await expect(
      page.locator('.fader[data-fader="mid"] .fader-value'),
    ).toHaveText('0dB');
    await expect(
      page.locator('.fader[data-fader="high"] .fader-value'),
    ).toHaveText('0dB');
  });

  test('EQ slider updates its displayed gain', async ({ page }) => {
    await page.locator('input[aria-label="Loop mid EQ"]').evaluate((input) => {
      input.value = '6';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect(
      page.locator('.fader[data-fader="mid"] .fader-value'),
    ).toHaveText('+6dB');
  });

  test('loop card exposes independent speed and pitch sliders', async ({ page }) => {
    await expect(page.locator('.fader:has-text("Speed") input[aria-label="Loop speed"]')).toBeVisible();
    await expect(page.locator('.fader:has-text("Pitch") input[aria-label="Loop pitch"]')).toBeVisible();
  });

  test('loop controls expose descriptive slider labels and value text', async ({ page }) => {
    const nameInput = page.locator('.loop-name');
    const volumeSlider = page.locator('input[aria-label="Loop volume"]');
    const panSlider = page.locator('input[aria-label="Loop pan"]');
    const speedSlider = page.locator('input[aria-label="Loop speed"]');

    await expect(nameInput).toHaveAttribute('aria-label', 'Loop name for Loop 1');
    await expect(page.locator('.loop-waveform canvas')).toHaveAttribute('aria-hidden', 'true');

    await expect(volumeSlider).toHaveAttribute('aria-label', 'Loop volume');
    await expect(volumeSlider).toHaveAttribute('aria-valuetext', '100 percent');

    await expect(panSlider).toHaveAttribute('aria-label', 'Loop pan');
    await expect(panSlider).toHaveAttribute('aria-valuetext', 'Center');

    await expect(speedSlider).toHaveAttribute('aria-label', 'Loop speed');
    await expect(speedSlider).toHaveAttribute('aria-valuetext', 'Normal speed');

    await setRangeValue(volumeSlider, '1.25');
    await setRangeValue(panSlider, '-0.5');
    await setRangeValue(speedSlider, '1.5');

    await expect(volumeSlider).toHaveAttribute('aria-valuetext', '125 percent');
    await expect(panSlider).toHaveAttribute('aria-valuetext', '50 percent left');
    await expect(speedSlider).toHaveAttribute('aria-valuetext', '1.5 times speed');

    await nameInput.fill('Bass');
    await nameInput.press('Enter');
    await expect(nameInput).toHaveAttribute('aria-label', 'Loop name for Bass');
  });

  test('active loop controls and delete button meet text contrast requirements', async ({ page }) => {
    await page.locator('.btn-mute').click();
    await page.locator('.btn-reverse').click();

    await expectContrastRatioAtLeast(page.locator('.loop-actions .btn-danger'), 4.5);
    await expectContrastRatioAtLeast(page.locator('.btn-mute'), 4.5);
    await expectContrastRatioAtLeast(page.locator('.btn-reverse'), 4.5);
  });

  test('waveform shows an animated playhead during playback', async ({ page }) => {
    const playhead = page.locator('.loop-playhead');
    await page.locator('.btn-play').click();
    await expect(playhead).toHaveClass(/active/);

    const before = await getPlayheadLeftPercent(page);
    await expect
      .poll(async () => {
        const after = await getPlayheadLeftPercent(page);
        return after >= before ? after - before : after + 100 - before;
      }, { timeout: 1000 })
      .toBeGreaterThan(5);
  });

  test('clicking the waveform scrubs the loop position', async ({ page }) => {
    const waveform = page.locator('.loop-waveform');
    const box = await waveform.boundingBox();
    if (!box) throw new Error('Waveform was not rendered');

    await waveform.click({ position: { x: box.width * 0.75, y: box.height / 2 } });
    await expect
      .poll(() => getPlayheadLeftPercent(page), { timeout: 1000 })
      .toBeGreaterThan(65);

    await page.locator('.btn-play').click();
    await expect(page.locator('.loop-playhead')).toHaveClass(/active/);
    await expect
      .poll(() => getPlayheadLeftPercent(page), { timeout: 1000 })
      .toBeGreaterThan(65);
  });

  test('existing loop can be re-quantized to the current BPM grid', async ({ page }) => {
    await expect(page.locator('.loop-card')).toBeVisible();
    await expect(page.locator('.loop-duration')).toHaveText('0:00');
    await page.locator('#bpm-input').fill('240');
    await page.locator('#bpm-input').press('Tab');
    await expect(page.locator('#bpm-input')).toHaveValue('240');
    await page.locator('.btn-quantize').click();
    await expect(page.locator('.loop-duration')).toHaveText('0:01');
    await expect(page.locator('#status-text')).toContainText('Re-quantized');
  });

  test('undo button becomes enabled after a loop is deleted', async ({ page }) => {
    await deleteLoopButton(page).click();
    await expect(page.locator('#btn-undo')).toBeEnabled();
  });

  test('deleted loop can be restored via undo button', async ({ page }) => {
    await deleteLoopButton(page).click();
    await expect(page.locator('.loop-card')).not.toBeVisible();
    await page.click('#btn-undo');
    await expect(page.locator('.loop-card')).toBeVisible();
  });

  test('Ctrl+Z restores the last deleted loop', async ({ page }) => {
    await deleteLoopButton(page).click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.loop-card')).toBeVisible();
  });

  test('lead button toggles on a loop', async ({ page }) => {
    const leadButton = page.locator('.btn-lead').first();
    await expect(leadButton).toHaveAttribute('aria-pressed', 'false');
    await leadButton.click();
    await expect(leadButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('only one loop can be marked as lead at a time', async ({ page }) => {
    // Record a second loop.
    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toHaveCount(2, { timeout: 8000 });

    const firstLeadButton = page.locator('.loop-card').nth(0).locator('.btn-lead');
    const secondLeadButton = page.locator('.loop-card').nth(1).locator('.btn-lead');

    await firstLeadButton.click();
    await expect(firstLeadButton).toHaveAttribute('aria-pressed', 'true');

    await secondLeadButton.click();
    await expect(firstLeadButton).toHaveAttribute('aria-pressed', 'false');
    await expect(secondLeadButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('punch-in overdubs a selected bar range without creating another loop', async ({ page }) => {
    const punchBpm = 240;
    const punchBarDurationMs = (60000 / punchBpm) * 4;
    const processingBufferMs = 500;

    await page.locator('#bpm-input').fill('240');
    await page.locator('#bpm-input').press('Tab');
    await page.locator('#punch-toggle').check();
    await expect(page.locator('#punch-loop-select')).toBeEnabled();
    await page.click('#btn-record');
    await expect(page.locator('#btn-record')).toContainText('STOP');
    await expect(page.locator('#btn-record')).toContainText('REC', {
      timeout: punchBarDurationMs + processingBufferMs,
    });
    await expect(page.locator('.loop-card')).toHaveCount(1);
    await expect(page.locator('#status-text')).toContainText('Punch-in applied');
  });

  test('redo button re-applies the last undone delete', async ({ page }) => {
    await deleteLoopButton(page).click();
    await page.click('#btn-undo');
    await expect(page.locator('#btn-redo')).toBeEnabled();
    await page.click('#btn-redo');
    await expect(page.locator('.loop-card')).toHaveCount(0);
  });

  test('Ctrl+Shift+Z re-applies the last undone delete', async ({ page }) => {
    await deleteLoopButton(page).click();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator('.loop-card')).toHaveCount(0);
  });

  test('clear all asks for confirmation and leaves loops untouched when cancelled', async ({ page }) => {
    await recordShortLoop(page);
    await expect(page.locator('.loop-card')).toHaveCount(2, { timeout: 8000 });

    let dialogMessage = '';
    page.once('dialog', async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    });

    await page.click('#btn-clear-all');

    await expect(page.locator('.loop-card')).toHaveCount(2);
    expect(dialogMessage).toBe('Clear all 2 loops? This will remove them from your current session.');
  });

  test('clear all removes every loop and can be undone', async ({ page }) => {
    await recordShortLoop(page);
    await expect(page.locator('.loop-card')).toHaveCount(2, { timeout: 8000 });

    page.once('dialog', dialog => dialog.accept());
    await page.click('#btn-clear-all');

    await expect(page.locator('.loop-card')).toHaveCount(0);
    await expect(page.locator('#empty-state')).toBeVisible();
    await page.click('#btn-undo');
    await expect(page.locator('.loop-card')).toHaveCount(2);
  });

  test('now-playing indicator updates while a loop is playing', async ({ page }) => {
    const position = page.locator('#playback-position');
    await expect(position).toHaveText('Now playing: —');
    await page.locator('#bpm-input').fill('240');
    await page.locator('#bpm-input').press('Tab');
    await page.locator('.btn-play').click();
    await expect(position).toContainText('Bar 1');
    await expect.poll(async () => await position.textContent()).toMatch(/Beat [2-4]/);
  });
});

// ─── Mobile layout ────────────────────────────────────────────────────────────

test.describe('mobile layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.click('#btn-request-mic');
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });
    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
  });

  test('uses touch-friendly controls on portrait phone screens', async ({ page }) => {
    const sizes = await page.locator('#btn-record, .loop-actions button').evaluateAll((buttons) => {
      return buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    });

    for (const size of sizes) {
      expect(size.width).toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('stacks the mixer without horizontal overflow on portrait phone screens', async ({ page }) => {
    const mobileLayout = await page.locator('.loop-faders').evaluate((el) => {
      const view = el.ownerDocument.defaultView;
      return {
        flexDirection: view.getComputedStyle(el).flexDirection,
        scrollWidth: el.ownerDocument.documentElement.scrollWidth,
        innerWidth: view.innerWidth,
      };
    });

    expect(mobileLayout.flexDirection).toBe('column');
    expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.innerWidth + 1);
  });
});

// ─── Gamepad controls ─────────────────────────────────────────────────────────

test.describe('gamepad controls', () => {
  test.beforeEach(async ({ page }) => {
    await installGamepadStub(page);
    await page.goto('/');
    await page.click('#btn-request-mic');
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });
  });

  test('button 1 starts and stops recording', async ({ page }) => {
    await pressGamepadButton(page, 0);
    await expect(page.locator('#btn-record')).toContainText('STOP');

    await page.waitForTimeout(600);
    await pressGamepadButton(page, 0);

    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
  });

  test('buttons 2 and 3 play and stop all loops', async ({ page }) => {
    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });

    await pressGamepadButton(page, 1);
    await expect(page.locator('.loop-card')).toHaveClass(/playing/);

    await pressGamepadButton(page, 2);
    await expect(page.locator('.loop-card')).not.toHaveClass(/playing/);
  });

  test('the fourth gamepad button cycles through loops and toggles them in order', async ({ page }) => {
    for (let i = 0; i < 2; i++) {
      await page.click('#btn-record');
      await page.waitForTimeout(600);
      await page.click('#btn-record');
      await expect(page.locator('.loop-card')).toHaveCount(i + 1, { timeout: 8000 });
    }

    const firstLoop = page.locator('#loop-card-1');
    const secondLoop = page.locator('#loop-card-2');

    await pressGamepadButton(page, 3);
    await expect(firstLoop).toHaveClass(/playing/);
    await expect(secondLoop).not.toHaveClass(/playing/);

    await pressGamepadButton(page, 3);
    await expect(firstLoop).toHaveClass(/playing/);
    await expect(secondLoop).toHaveClass(/playing/);

    await pressGamepadButton(page, 3);
    await expect(firstLoop).not.toHaveClass(/playing/);
    await expect(secondLoop).toHaveClass(/playing/);
  });
});

// ─── MIDI controls ────────────────────────────────────────────────────────────

test.describe('MIDI controls', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeMidi(page);
    await page.goto('/');
    await page.click('#btn-request-mic');
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });
    await page.click('#btn-enable-midi');
    await expect(page.locator('#midi-status')).toContainText('Listening to 1 MIDI input');
  });

  test('can learn a MIDI button for recording', async ({ page }) => {
    await page.locator('[data-midi-action="record"] .btn-midi-learn').click();
    await page.evaluate(() => globalThis.__dispatchMidi([0x90, 36, 127]));
    await expect(page.locator('[data-midi-action="record"] .midi-binding-value')).toHaveText('Note 36 · Ch 1');

    await page.evaluate(() => globalThis.__dispatchMidi([0x90, 36, 127]));
    await expect(page.locator('#btn-record')).toContainText('STOP');
  });

  test('can learn a loop toggle and volume control', async ({ page }) => {
    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });

    const loopCard = page.locator('.loop-card').first();

    await loopCard.locator('.btn-midi-learn[data-midi-target="loop-1-toggle"]').click();
    await page.evaluate(() => globalThis.__dispatchMidi([0x90, 40, 127]));
    await expect(loopCard.locator('[data-midi-binding="toggle"]')).toHaveText('Note 40 · Ch 1');

    await page.evaluate(() => globalThis.__dispatchMidi([0x90, 40, 127]));
    await expect(loopCard).toHaveClass(/playing/);

    await loopCard.locator('.btn-midi-learn[data-midi-target="loop-1-volume"]').click();
    await page.evaluate(() => globalThis.__dispatchMidi([0xb0, 7, 64]));
    await expect(loopCard.locator('[data-midi-binding="volume"]')).toHaveText('CC 7 · Ch 1');

    await page.evaluate(() => globalThis.__dispatchMidi([0xb0, 7, 0]));
    await expect(loopCard.locator('[data-fader="volume"] input')).toHaveValue('0');
  });
});

// ─── Tempo controls ───────────────────────────────────────────────────────────

test.describe('tempo controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-request-mic');
    await expect(page.locator('#tempo-controls')).toBeVisible({ timeout: 5000 });
  });

  test('BPM can be updated via the input', async ({ page }) => {
    await page.locator('#bpm-input').fill('140');
    await page.locator('#bpm-input').press('Tab');
    await expect(page.locator('#bpm-input')).toHaveValue('140');
  });

  test('tap tempo button is visible', async ({ page }) => {
    await expect(page.locator('#btn-tap-tempo')).toBeVisible();
  });

  test('BPM is clamped to the minimum (40)', async ({ page }) => {
    await page.locator('#bpm-input').fill('10');
    await page.locator('#bpm-input').press('Tab');
    await expect(page.locator('#bpm-input')).toHaveValue('40');
  });

  test('BPM is clamped to the maximum (240)', async ({ page }) => {
    await page.locator('#bpm-input').fill('999');
    await page.locator('#bpm-input').press('Tab');
    await expect(page.locator('#bpm-input')).toHaveValue('240');
  });

  test('tap tempo updates BPM from inter-tap timing', async ({ page }) => {
    const tapTimes = [];
    await page.locator('#btn-tap-tempo').click();
    tapTimes.push(Date.now());
    await page.waitForTimeout(300);
    await page.locator('#btn-tap-tempo').click();
    tapTimes.push(Date.now());
    await page.waitForTimeout(300);
    await page.locator('#btn-tap-tempo').click();
    tapTimes.push(Date.now());

    const avgIntervalMs = ((tapTimes[1] - tapTimes[0]) + (tapTimes[2] - tapTimes[1])) / 2;
    const expectedBpm = Math.round(60000 / avgIntervalMs);
    const tappedBpm = Number(await page.locator('#bpm-input').inputValue());
    // Keep tolerance wide enough for timer jitter in shared CI workers.
    expect(Math.abs(tappedBpm - expectedBpm)).toBeLessThanOrEqual(20);
  });

  test('tap tempo ignores a single tap and resets after timeout', async ({ page }) => {
    await page.locator('#bpm-input').fill('123');
    await page.locator('#bpm-input').press('Tab');
    await expect(page.locator('#bpm-input')).toHaveValue('123');

    await page.locator('#btn-tap-tempo').click();
    await expect(page.locator('#bpm-input')).toHaveValue('123');

    await page.waitForTimeout(2100); // TAP_TEMPO_TIMEOUT_MS is 2000ms in src/app.js.
    await page.locator('#btn-tap-tempo').click();
    await expect(page.locator('#bpm-input')).toHaveValue('123');
  });

  test('metronome toggle can be enabled', async ({ page }) => {
    await page.locator('#metronome-toggle').check();
    await expect(page.locator('#metronome-toggle')).toBeChecked();
  });

  test('metronome subdivision can be set to 8ths', async ({ page }) => {
    await page.locator('#metronome-subdivision-input').selectOption('2');
    await expect(page.locator('#metronome-subdivision-input')).toHaveValue('2');
  });

  test('metronome subdivision can be set to 16ths', async ({ page }) => {
    await page.locator('#metronome-subdivision-input').selectOption('4');
    await expect(page.locator('#metronome-subdivision-input')).toHaveValue('4');
  });

  test('metronome subdivision can be set to triplets', async ({ page }) => {
    await page.locator('#metronome-subdivision-input').selectOption('3');
    await expect(page.locator('#metronome-subdivision-input')).toHaveValue('3');
  });

  test('count-in toggle can be enabled', async ({ page }) => {
    await page.locator('#count-in-toggle').check();
    await expect(page.locator('#count-in-toggle')).toBeChecked();
  });

  test('quantize toggle can be enabled', async ({ page }) => {
    await page.locator('#quantize-toggle').check();
    await expect(page.locator('#quantize-toggle')).toBeChecked();
  });

});

test('detected BPM from the first loop can be accepted', async ({ page }) => {
  await mockDetectedTempo(page, 120);

  await page.goto('/');
  await page.click('#btn-request-mic');
  await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });

  await recordFirstLoop(page);

  await expect(page.locator('#tempo-suggestion')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#tempo-suggestion-text')).toContainText('120 BPM');

  await page.click('#btn-apply-detected-tempo');
  await expect(page.locator('#bpm-input')).toHaveValue('120');
  await expect(page.locator('#tempo-suggestion')).toBeHidden();
});

test('detected BPM from the first loop can be dismissed', async ({ page }) => {
  await mockDetectedTempo(page, 120);

  await page.goto('/');
  await page.click('#btn-request-mic');
  await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });

  await recordFirstLoop(page);

  await expect(page.locator('#tempo-suggestion')).toBeVisible({ timeout: 8000 });
  await page.click('#btn-dismiss-detected-tempo');

  await expect(page.locator('#bpm-input')).toHaveValue('100');
  await expect(page.locator('#tempo-suggestion')).toBeHidden();
});

// ─── Share via URL ────────────────────────────────────────────────────────────

test.describe('share via URL', () => {
  test('creates a shareable hash and restores loops after reload', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-request-mic');
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });

    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });

    await page.click('#btn-share-session');
    await expect.poll(() => page.url()).toContain('#share=');

    await page.reload();
    await expect(page.locator('.loop-card')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#master-controls')).toBeVisible();
  });
});
