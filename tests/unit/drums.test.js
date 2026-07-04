import { describe, it, expect } from 'vitest';
import { buildDrumLoopPlan, getDrumStyleLabel } from '../../src/drums.js';

describe('getDrumStyleLabel', () => {
  it('returns the label for known styles', () => {
    expect(getDrumStyleLabel('rock')).toBe('Rock');
    expect(getDrumStyleLabel('funk')).toBe('Funk');
    expect(getDrumStyleLabel('reggae')).toBe('Reggae');
  });

  it('falls back to Rock for unknown styles', () => {
    expect(getDrumStyleLabel('unknown')).toBe('Rock');
  });
});

describe('buildDrumLoopPlan', () => {
  it('uses BPM and beats-per-bar to size the loop', () => {
    const plan = buildDrumLoopPlan({ style: 'rock', bpm: 120, beatsPerBar: 4 });
    expect(plan.beatDuration).toBeCloseTo(0.5);
    expect(plan.barDuration).toBeCloseTo(2);
  });

  it('builds the rock pattern with kick, snare, and hi-hat hits', () => {
    const plan = buildDrumLoopPlan({ style: 'rock', bpm: 100, beatsPerBar: 4 });
    expect(plan.hits.filter(hit => hit.sample === 'kick').map(hit => hit.beat)).toEqual([0, 2]);
    expect(plan.hits.filter(hit => hit.sample === 'snare').map(hit => hit.beat)).toEqual([1, 3]);
    expect(plan.hits.filter(hit => hit.sample === 'hat')).toHaveLength(8);
  });

  it('builds a syncopated funk pattern', () => {
    const plan = buildDrumLoopPlan({ style: 'funk', bpm: 100, beatsPerBar: 4 });
    expect(plan.hits.filter(hit => hit.sample === 'hat')).toHaveLength(16);
    expect(plan.hits.filter(hit => hit.sample === 'kick').map(hit => hit.beat)).toEqual([0, 0.75, 2, 2.75]);
    expect(plan.hits.filter(hit => hit.sample === 'snare').map(hit => hit.beat)).toEqual([1, 3]);
  });

  it('builds the reggae loop around the third beat', () => {
    const plan = buildDrumLoopPlan({ style: 'reggae', bpm: 90, beatsPerBar: 4 });
    expect(plan.hits.filter(hit => hit.sample === 'hat').map(hit => hit.beat)).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(plan.hits.filter(hit => hit.sample !== 'hat').map(hit => hit.beat)).toEqual([2, 2]);
  });

  it('omits the reggae snare on 2-beat bars', () => {
    const plan = buildDrumLoopPlan({ style: 'reggae', bpm: 90, beatsPerBar: 2 });
    expect(plan.hits.filter(hit => hit.sample === 'kick').map(hit => hit.beat)).toEqual([1]);
    expect(plan.hits.filter(hit => hit.sample === 'snare')).toHaveLength(0);
  });

  it('keeps the reggae one-drop stacked on beat 3 for 3-beat bars', () => {
    const plan = buildDrumLoopPlan({ style: 'reggae', bpm: 90, beatsPerBar: 3 });
    expect(plan.hits.filter(hit => hit.sample !== 'hat').map(hit => hit.beat)).toEqual([2, 2]);
  });

  it('leaves hit times straight when swing is 0 (default and explicit)', () => {
    const straight = buildDrumLoopPlan({ style: 'rock', bpm: 120, beatsPerBar: 4 });
    const explicitZero = buildDrumLoopPlan({ style: 'rock', bpm: 120, beatsPerBar: 4, swing: 0 });
    // beatDuration at 120 BPM = 0.5s, so time === beat * 0.5
    straight.hits.forEach((hit) => {
      expect(hit.time).toBeCloseTo(hit.beat * 0.5);
    });
    expect(explicitZero.hits.map(h => h.time)).toEqual(straight.hits.map(h => h.time));
    expect(straight.swing).toBe(0);
  });

  it('delays the off-beat 8th-note hi-hats when swing is applied', () => {
    const beatDuration = 0.5; // 120 BPM
    const swing = 0.5;
    const plan = buildDrumLoopPlan({ style: 'rock', bpm: 120, beatsPerBar: 4, swing });
    expect(plan.swing).toBe(swing);

    const hatAt = (beat) => plan.hits.find(h => h.sample === 'hat' && h.beat === beat);
    // Off-beat 8ths (0.5, 1.5, ...) get pushed back by swing * (beatDuration/2).
    const expectedDelay = swing * (beatDuration / 2);
    expect(hatAt(0.5).time).toBeCloseTo(0.5 * beatDuration + expectedDelay);
    expect(hatAt(1.5).time).toBeCloseTo(1.5 * beatDuration + expectedDelay);
    // On-beat hits stay exactly on the grid.
    expect(hatAt(0).time).toBeCloseTo(0);
    expect(hatAt(1).time).toBeCloseTo(1 * beatDuration);
  });

  it('keeps hits sorted by time after swing offsets are applied', () => {
    const plan = buildDrumLoopPlan({ style: 'funk', bpm: 100, beatsPerBar: 4, swing: 0.66 });
    const times = plan.hits.map(h => h.time);
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });
});
