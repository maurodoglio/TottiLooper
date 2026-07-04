/**
 * Unit tests for src/tour.js — the pure onboarding-tour state logic.
 */

import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_STORAGE_KEY,
  TOUR_STEPS,
  clampTourStep,
  nextTourStep,
  prevTourStep,
  isLastTourStep,
  isFirstTourStep,
} from '../../src/tour.js';

describe('tour constants', () => {
  it('exposes a stable storage key', () => {
    expect(ONBOARDING_STORAGE_KEY).toBe('tottiLooper.onboardingDone');
  });

  it('defines a non-empty ordered list of steps with target/title/body', () => {
    expect(Array.isArray(TOUR_STEPS)).toBe(true);
    expect(TOUR_STEPS.length).toBeGreaterThan(0);
    for (const step of TOUR_STEPS) {
      expect(typeof step.target).toBe('string');
      expect(step.target.length).toBeGreaterThan(0);
      expect(typeof step.title).toBe('string');
      expect(step.title.length).toBeGreaterThan(0);
      expect(typeof step.body).toBe('string');
      expect(step.body.length).toBeGreaterThan(0);
    }
  });
});

describe('clampTourStep', () => {
  it('keeps in-range indices unchanged', () => {
    expect(clampTourStep(0, 7)).toBe(0);
    expect(clampTourStep(3, 7)).toBe(3);
    expect(clampTourStep(6, 7)).toBe(6);
  });

  it('clamps below 0 to 0', () => {
    expect(clampTourStep(-1, 7)).toBe(0);
    expect(clampTourStep(-100, 7)).toBe(0);
  });

  it('clamps above the last index to the last index', () => {
    expect(clampTourStep(7, 7)).toBe(6);
    expect(clampTourStep(999, 7)).toBe(6);
  });

  it('floors fractional indices', () => {
    expect(clampTourStep(2.9, 7)).toBe(2);
  });

  it('returns 0 for a non-finite index', () => {
    expect(clampTourStep(NaN, 7)).toBe(0);
    expect(clampTourStep(Infinity, 7)).toBe(0);
    expect(clampTourStep(-Infinity, 7)).toBe(0);
  });

  it('returns 0 for an empty or invalid tour', () => {
    expect(clampTourStep(3, 0)).toBe(0);
    expect(clampTourStep(3, NaN)).toBe(0);
    expect(clampTourStep(3, -5)).toBe(0);
  });
});

describe('nextTourStep / prevTourStep', () => {
  it('advances by one within bounds', () => {
    expect(nextTourStep(0, 7)).toBe(1);
    expect(nextTourStep(4, 7)).toBe(5);
  });

  it('does not advance past the last step', () => {
    expect(nextTourStep(6, 7)).toBe(6);
    expect(nextTourStep(100, 7)).toBe(6);
  });

  it('goes back by one within bounds', () => {
    expect(prevTourStep(6, 7)).toBe(5);
    expect(prevTourStep(1, 7)).toBe(0);
  });

  it('does not go before the first step', () => {
    expect(prevTourStep(0, 7)).toBe(0);
    expect(prevTourStep(-50, 7)).toBe(0);
  });
});

describe('isFirstTourStep / isLastTourStep', () => {
  it('detects the first step', () => {
    expect(isFirstTourStep(0, 7)).toBe(true);
    expect(isFirstTourStep(1, 7)).toBe(false);
    expect(isFirstTourStep(-3, 7)).toBe(true);
  });

  it('detects the last step', () => {
    expect(isLastTourStep(6, 7)).toBe(true);
    expect(isLastTourStep(5, 7)).toBe(false);
    expect(isLastTourStep(999, 7)).toBe(true);
  });

  it('treats an empty tour as already on the last step', () => {
    expect(isLastTourStep(0, 0)).toBe(true);
  });

  it('agrees with the real TOUR_STEPS length', () => {
    const total = TOUR_STEPS.length;
    expect(isFirstTourStep(0, total)).toBe(true);
    expect(isLastTourStep(total - 1, total)).toBe(true);
    expect(nextTourStep(total - 1, total)).toBe(total - 1);
  });
});
