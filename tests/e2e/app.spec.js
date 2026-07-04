/**
 * End-to-end tests for TottiLooper.
 *
 * The Playwright config starts a static file server and launches Chromium with
 * `--use-fake-device-for-media-stream` + `--use-fake-ui-for-media-stream` so
 * that the microphone permission dialog is auto-accepted and all recording uses
 * a synthetic audio signal — no real microphone required.
 */

import { test, expect } from '@playwright/test';

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

  test('hides tempo controls before mic is granted', async ({ page }) => {
    await expect(page.locator('#tempo-controls')).not.toBeVisible();
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

  test('shows the master controls', async ({ page }) => {
    await expect(page.locator('#master-controls')).toBeVisible();
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

  test('master volume slider defaults to 1', async ({ page }) => {
    await expect(page.locator('#master-volume')).toHaveValue('1');
  });

  test('MIDI click export toggle is available', async ({ page }) => {
    await expect(page.locator('#export-midi-toggle')).toBeVisible();
  });

  test('status text shows ready message', async ({ page }) => {
    await expect(page.locator('#status-text')).toContainText('Ready');
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

// ─── Loop controls ────────────────────────────────────────────────────────────

test.describe('loop controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-request-mic');
    await expect(page.locator('#record-controls')).toBeVisible({ timeout: 5000 });
    // Record one short loop.
    await page.click('#btn-record');
    await page.waitForTimeout(600);
    await page.click('#btn-record');
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
    await page.locator('.btn-danger').click();
    await expect(page.locator('#btn-undo')).toBeEnabled();
  });

  test('deleted loop can be restored via undo button', async ({ page }) => {
    await page.locator('.btn-danger').click();
    await expect(page.locator('.loop-card')).not.toBeVisible();
    await page.click('#btn-undo');
    await expect(page.locator('.loop-card')).toBeVisible();
  });

  test('Ctrl+Z restores the last deleted loop', async ({ page }) => {
    await page.locator('.btn-danger').click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.loop-card')).toBeVisible();
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

  test('metronome toggle can be enabled', async ({ page }) => {
    await page.locator('#metronome-toggle').check();
    await expect(page.locator('#metronome-toggle')).toBeChecked();
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
