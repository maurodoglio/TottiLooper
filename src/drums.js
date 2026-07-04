'use strict';

import { swingDelaySeconds } from './utils.js';

export const DRUM_STYLE_OPTIONS = [
  { value: 'rock', label: 'Rock' },
  { value: 'funk', label: 'Funk' },
  { value: 'reggae', label: 'Reggae' },
];

export const DRUM_SAMPLE_FILES = {
  kick: new URL('./samples/kick.wav', import.meta.url).href,
  snare: new URL('./samples/snare.wav', import.meta.url).href,
  hat: new URL('./samples/hihat.wav', import.meta.url).href,
};

const STYLE_LABELS = Object.fromEntries(
  DRUM_STYLE_OPTIONS.map(({ value, label }) => [value, label]),
);

function normalizeStyle(style) {
  return STYLE_LABELS[style] ? style : 'rock';
}

function addHit(hits, sample, beat, gain, beatsPerBar) {
  if (beat < 0 || beat >= beatsPerBar) return;
  hits.push({ sample, beat, gain });
}

export function getDrumStyleLabel(style) {
  return STYLE_LABELS[normalizeStyle(style)];
}

export function buildDrumLoopPlan({ style, bpm, beatsPerBar, swing = 0 }) {
  const safeStyle = normalizeStyle(style);
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 100;
  const safeBeatsPerBar = Number.isFinite(beatsPerBar) && beatsPerBar > 0
    ? Math.max(1, Math.floor(beatsPerBar))
    : 4;
  const safeSwing = Number.isFinite(swing) ? swing : 0;
  const beatDuration = 60 / safeBpm;
  const barDuration = beatDuration * safeBeatsPerBar;
  const hits = [];

  switch (safeStyle) {
    case 'funk':
      for (let beat = 0; beat < safeBeatsPerBar; beat += 0.25) {
        const subdivision = Math.round((beat % 1) * 4) % 4;
        const gain = subdivision === 0 ? 0.7 : subdivision === 2 ? 0.55 : 0.42;
        addHit(hits, 'hat', beat, gain, safeBeatsPerBar);
      }
      [0, 0.75, 2, 2.75].forEach((beat) => addHit(hits, 'kick', beat, 1, safeBeatsPerBar));
      [1, 3].forEach((beat) => addHit(hits, 'snare', beat, 0.95, safeBeatsPerBar));
      break;

    case 'reggae': {
      for (let beat = 0.5; beat < safeBeatsPerBar; beat += 1) {
        addHit(hits, 'hat', beat, 0.65, safeBeatsPerBar);
      }
      const oneDropBeat = safeBeatsPerBar > 2 ? 2 : safeBeatsPerBar - 1;
      addHit(hits, 'kick', oneDropBeat, 0.95, safeBeatsPerBar);
      if (safeBeatsPerBar > 2) {
        addHit(hits, 'snare', oneDropBeat, 0.85, safeBeatsPerBar);
      }
      break;
    }

    case 'rock':
    default: {
      for (let beat = 0; beat < safeBeatsPerBar; beat += 0.5) {
        addHit(hits, 'hat', beat, beat % 1 === 0 ? 0.6 : 0.45, safeBeatsPerBar);
      }
      addHit(hits, 'kick', 0, 1, safeBeatsPerBar);
      const midpointBeat = Math.floor(safeBeatsPerBar / 2);
      if (midpointBeat > 0) {
        addHit(hits, 'kick', midpointBeat, 0.9, safeBeatsPerBar);
      }
      [1, 3].forEach((beat) => addHit(hits, 'snare', beat, 0.95, safeBeatsPerBar));
      break;
    }
  }

  const swingSubdivision = beatDuration / 2;
  return {
    style: safeStyle,
    beatDuration,
    barDuration,
    swing: safeSwing,
    hits: hits
      .map((hit) => {
        // Swing the off-beat 8th notes to match the metronome shuffle feel.
        // Hits that sit exactly on an 8th-note gridline get nudged; finer
        // subdivisions (16th hats) stay put, as in a natural swing groove.
        const gridIndex = hit.beat * 2;
        const swingDelay = Number.isInteger(gridIndex)
          ? swingDelaySeconds(gridIndex, safeSwing, swingSubdivision)
          : 0;
        return {
          ...hit,
          time: hit.beat * beatDuration + swingDelay,
        };
      })
      .sort((a, b) => a.time - b.time),
  };
}
