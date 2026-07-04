import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  eventToShortcut,
  loadShortcutMappings,
  normalizeShortcut,
  saveShortcutMappings,
  SHORTCUT_STORAGE_KEY,
} from '../../src/shortcuts.js';

function createStorage(seed) {
  const store = new Map(seed ? [[SHORTCUT_STORAGE_KEY, seed]] : []);
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

describe('normalizeShortcut', () => {
  it('normalizes aliases and casing', () => {
    expect(normalizeShortcut('ctrl + z')).toBe('Mod+Z');
    expect(normalizeShortcut('esc')).toBe('Escape');
    expect(normalizeShortcut('space')).toBe('Space');
  });

  it('returns an empty string for invalid shortcuts', () => {
    expect(normalizeShortcut('Ctrl+Alt+')).toBe('');
    expect(normalizeShortcut('a+b+c')).toBe('');
  });
});

describe('eventToShortcut', () => {
  it('maps ctrl/cmd combinations to Mod', () => {
    expect(eventToShortcut({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe('Mod+Z');
    expect(eventToShortcut({ key: 'z', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe('Mod+Z');
  });

  it('keeps shifted symbols as their printable character', () => {
    expect(eventToShortcut({ key: '?', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false })).toBe('?');
  });

  it('normalizes the space character to Space', () => {
    expect(eventToShortcut({ key: ' ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe('Space');
  });

  it('ignores modifier-only keys', () => {
    expect(eventToShortcut({ key: 'Shift', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false })).toBe('');
  });
});

describe('shortcut storage', () => {
  it('loads saved shortcuts over the defaults', () => {
    const storage = createStorage(JSON.stringify({
      ...DEFAULT_SHORTCUTS,
      toggleRecord: 'r',
      playAll: 'shift+p',
    }));

    expect(loadShortcutMappings(storage)).toMatchObject({
      toggleRecord: 'R',
      playAll: 'Shift+P',
      stopAll: 'Escape',
    });
  });

  it('falls back to defaults for invalid stored data', () => {
    const storage = createStorage('{"toggleRecord":');
    expect(loadShortcutMappings(storage)).toEqual(DEFAULT_SHORTCUTS);
  });

  it('saves normalized shortcuts', () => {
    const storage = createStorage();
    saveShortcutMappings({
      ...DEFAULT_SHORTCUTS,
      toggleRecord: 'shift+r',
    }, storage);

    expect(JSON.parse(storage.getItem(SHORTCUT_STORAGE_KEY))).toMatchObject({
      toggleRecord: 'Shift+R',
      stopAll: 'Escape',
    });
  });
});
