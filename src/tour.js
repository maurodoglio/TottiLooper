/**
 * Onboarding tour — pure, framework-free state logic.
 *
 * Everything in this module is DOM-free so it can be unit tested in plain Node.
 * The actual overlay rendering lives in app.js and consumes these helpers.
 */

/** localStorage key that records whether the first-run tour has been completed. */
export const ONBOARDING_STORAGE_KEY = 'tottiLooper.onboardingDone';

/**
 * Ordered tour steps. Each step points at an existing control in the UI. If a
 * target happens to be hidden (e.g. before the microphone is granted) the
 * renderer falls back to a centred tooltip, so the tour never breaks.
 */
export const TOUR_STEPS = [
  {
    target: '#btn-record',
    title: 'Record & arm',
    body: 'Hit ● REC to capture a loop from your input. Recordings snap to the bar so every layer lines up.',
  },
  {
    target: '#loops-section',
    title: 'Your loops',
    body: 'Recorded and sampled loops stack up here. Mute, solo, pan, reverse or group them to build an arrangement.',
  },
  {
    target: '#tempo-controls',
    title: 'Tempo & BPM',
    body: 'Set the BPM by hand or with Tap Tempo, choose the time signature, and quantize new loops to the grid.',
  },
  {
    target: '#metronome-toggle',
    title: 'Metronome & groove',
    body: 'Turn on the click, pick a subdivision, add a count-in, and dial in Swing for a shuffle feel.',
  },
  {
    target: '#drum-controls',
    title: 'Instant drums & FX',
    body: 'Generate a drum bed in a chosen style, then shape each loop with its own effects chain.',
  },
  {
    target: '#master-controls',
    title: 'Master bus',
    body: 'Play or stop everything, ride the master volume, add global reverb and the bus compressor, then export a mix.',
  },
  {
    target: '#scenes-section',
    title: 'Scenes & setlist',
    body: 'Snapshot the whole mix into scenes and trigger them live with keys 1–9, with an optional crossfade.',
  },
];

/**
 * Clamp a step index into the valid range for a tour of `total` steps.
 * Non-finite input collapses to 0, and an empty tour always yields 0.
 *
 * @param {number} step
 * @param {number} total
 * @returns {number} integer in [0, max(0, total - 1)]
 */
export function clampTourStep(step, total) {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const max = Math.max(0, count - 1);
  if (!Number.isFinite(step)) return 0;
  const idx = Math.floor(step);
  if (idx < 0) return 0;
  if (idx > max) return max;
  return idx;
}

/**
 * Next step index, clamped so it never runs off the end of the tour.
 * @param {number} step
 * @param {number} total
 * @returns {number}
 */
export function nextTourStep(step, total) {
  return clampTourStep(clampTourStep(step, total) + 1, total);
}

/**
 * Previous step index, clamped so it never goes below the first step.
 * @param {number} step
 * @param {number} total
 * @returns {number}
 */
export function prevTourStep(step, total) {
  return clampTourStep(clampTourStep(step, total) - 1, total);
}

/**
 * True when `step` is the final step of a `total`-length tour.
 * @param {number} step
 * @param {number} total
 * @returns {boolean}
 */
export function isLastTourStep(step, total) {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (count <= 0) return true;
  return clampTourStep(step, total) >= count - 1;
}

/**
 * True when `step` is the first step of the tour.
 * @param {number} step
 * @param {number} total
 * @returns {boolean}
 */
export function isFirstTourStep(step, total) {
  return clampTourStep(step, total) === 0;
}
