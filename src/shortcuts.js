'use strict';

export const SHORTCUT_STORAGE_KEY = 'tottilooper.shortcuts';

export const DEFAULT_SHORTCUTS = Object.freeze({
  toggleRecord: 'Space',
  playAll: 'Enter',
  stopAll: 'Escape',
  openHelp: '?',
  undoDelete: 'Mod+Z',
  toggleLoop1: '1',
  toggleLoop2: '2',
  toggleLoop3: '3',
  toggleLoop4: '4',
  toggleLoop5: '5',
  toggleLoop6: '6',
  toggleLoop7: '7',
  toggleLoop8: '8',
  toggleLoop9: '9',
});

const MODIFIER_ORDER = ['Mod', 'Shift', 'Alt'];
const KEY_ALIASES = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  '?': '?',
};
const MODIFIER_ALIASES = {
  cmd: 'Mod',
  command: 'Mod',
  ctrl: 'Mod',
  control: 'Mod',
  meta: 'Mod',
  mod: 'Mod',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
};

function normalizeKeyToken(token) {
  if (!token) return '';

  const lowered = token.trim().toLowerCase();
  if (!lowered) return '';
  if (KEY_ALIASES[lowered]) return KEY_ALIASES[lowered];
  if (/^[a-z]$/.test(lowered)) return lowered.toUpperCase();
  if (/^[0-9]$/.test(lowered)) return lowered;
  if (token.length === 1) return token;
  return token;
}

export function normalizeShortcut(value) {
  if (typeof value !== 'string') return '';

  const parts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return '';

  const modifiers = new Set();
  let key = '';

  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (MODIFIER_ALIASES[lowered]) {
      modifiers.add(MODIFIER_ALIASES[lowered]);
      continue;
    }

    if (key) return '';
    key = normalizeKeyToken(part);
  }

  if (!key) return '';

  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  ].join('+');
}

export function eventToShortcut(event) {
  if (!event || typeof event.key !== 'string') return '';

  const key = normalizeKeyToken(event.key);
  if (!key || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return '';

  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Mod');
  const isShiftedSymbol = key.length === 1 && !/[A-Z0-9]/.test(key);
  if (event.shiftKey && !isShiftedSymbol) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(key);
  return normalizeShortcut(parts.join('+'));
}

export function loadShortcutMappings(storage = globalThis.localStorage) {
  const shortcuts = { ...DEFAULT_SHORTCUTS };
  if (!storage) return shortcuts;

  try {
    const raw = storage.getItem(SHORTCUT_STORAGE_KEY);
    if (!raw) return shortcuts;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return shortcuts;

    for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
      if (!Object.prototype.hasOwnProperty.call(parsed, action)) continue;
      const normalized = normalizeShortcut(parsed[action]);
      shortcuts[action] = normalized || '';
    }
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }

  return shortcuts;
}

export function saveShortcutMappings(shortcuts, storage = globalThis.localStorage) {
  if (!storage) return;

  try {
    const normalized = {};
    for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
      normalized[action] = normalizeShortcut(shortcuts[action]);
    }

    storage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage errors and keep in-memory shortcuts active for this session.
  }
}
