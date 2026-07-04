import { describe, it, expect } from 'vitest';
import { buildDrumLoopPlan, getDrumStyleLabel } from '../../src/drums.js';

describe('getDrumStyleLabel', () => {
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
});
