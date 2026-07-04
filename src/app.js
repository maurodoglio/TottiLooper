/**
 * TottiLooper – main application logic.
 *
 * Solo musicians record short riffs and layer them as continuously-looping
 * audio tracks, simulating a full band while busking.
 */

'use strict';

import {
  formatDuration,
  formatBarBeatPosition,
  panText,
  parseMidiMessage,
  createMidiBinding,
  matchesMidiBinding,
  isMidiButtonPress,
  scaleMidiValue,
  formatMidiBinding,
  audioBufferToWav,
  barsToDurationSeconds as _barsToDurationSeconds,
  applyLoopEdits as buildLoopBuffer,
  createBuiltinSampleLoop,
  detectKey as detectLoopKey,
  shouldWarnAboutKeyClash,
  clickTrackToMidi,
  getSupportedMimeType,
  getBeatSeconds,
  estimateTempo,
  packSharedSession,
  effectiveGain as computeEffectiveGain,
  clampSceneCrossfadeBars,
  normalizeSongTimeline,
  getLoopPlaybackRate as computeLoopPlaybackRate,
  fitBufferToBars as _fitBufferToBars,
  quantizeBuffer as _quantizeBuffer,
  offsetBuffer as _offsetBuffer,
  reverseBuffer as _reverseBuffer,
  makeDistortionCurve,
  makeReverbIR,
  sceneCrossfadeDuration,
  applyPunchIn as _applyPunchIn,
  transformBuffer as _transformBuffer,
  unpackSharedSession,
} from './utils.js';
import {
  DRUM_SAMPLE_FILES,
  buildDrumLoopPlan,
  getDrumStyleLabel,
} from './drums.js';
import {
  DEFAULT_SHORTCUTS,
  eventToShortcut,
  loadShortcutMappings,
  saveShortcutMappings,
} from './shortcuts.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FADE_TIME        = 0.015; // seconds – short fades to avoid clicks on start/stop
const IMMEDIATE_START_THRESHOLD = 0.05; // seconds – starts within 50 ms flip the UI to "playing" right away; later (song-mode) starts defer until they actually begin
const LOOP_RESTART_DELAY_MS = Math.ceil(FADE_TIME * 1000 * 6);
const METRONOME_VOLUME = 0.3;
const METRONOME_DOWNBEAT_FREQ = 1760;
const METRONOME_BEAT_FREQ = 1175;
const METRONOME_SUBDIVISION_FREQ = 880;
const METRONOME_DOWNBEAT_VOLUME_MULTIPLIER = 1.5;
const METRONOME_SUBDIVISION_VOLUME_MULTIPLIER = 0.5;
const VALID_METRONOME_SUBDIVISIONS = [1, 2, 3, 4];
const DEFAULT_BPM      = 100;
const MIN_BPM          = 40;
const MAX_BPM          = 240;
const DEFAULT_SONG_BARS = 8;
const MAX_SONG_BARS     = 128;
const SONG_START_DELAY  = 0.05; // seconds – small look-ahead so Web Audio can schedule bar-aligned starts
const MIN_LOOP_LENGTH_BARS = 1;
const MAX_LOOP_LENGTH_BARS = 32;
const TAP_TEMPO_TIMEOUT_MS = 2000;
const TAP_TEMPO_MAX_TAPS = 8;
const MAX_UNDO         = 20;
const DEFAULT_SCENE_CROSSFADE_BARS = 1;
const MAX_SCENES       = 9;
const DUCK_GAIN        = 0.35; // Non-lead loops play at 35% volume when the lead is playing.
// Wait a few fade time-constants before restarting playback so the old source
// has decayed enough to avoid an audible click or doubled attack.
const FADE_SETTLE_MULTIPLIER = 6;
const LOOP_EDIT_RESOLUTION = 1000;
const LOOP_RESTART_DELAY_MULTIPLIER = 6; // wait a few fade time-constants before restarting a loop
const NORMAL_PLAYBACK_RATE = 1;
const HALF_TIME_PLAYBACK_RATE = 0.5;
const DOUBLE_TIME_PLAYBACK_RATE = 2;
const PLAYBACK_RATE_EPSILON = 0.001;
const PARAM_TRANSITION = 0.01;
const LOW_EQ_FREQUENCY = 200;
const MID_EQ_FREQUENCY = 1200;
const MID_EQ_Q         = 0.8;
const HIGH_EQ_FREQUENCY = 3200;
const EQ_FILTER_BY_BAND = {
  lowEq: 'lowShelf',
  midEq: 'midPeak',
  highEq: 'highShelf',
};
const POSITION_UPDATE_INTERVAL_MS = 50;
const IDLE_PLAYBACK_POSITION = 'Now playing: —';
const THEME_STORAGE_KEY = 'tottilooper-theme';
const GAMEPAD_RECORD_BUTTON = 0;
const GAMEPAD_PLAY_BUTTON   = 1;
const GAMEPAD_STOP_BUTTON   = 2;
const GAMEPAD_NEXT_BUTTON   = 3;
const MAX_SHARE_FRAGMENT_LENGTH = 12000; // Keeps shared URLs comfortably below common browser limits.
const MIN_MONITOR_OFFSET_MS = -250;
const MAX_MONITOR_OFFSET_MS = 250;

// ─── State ────────────────────────────────────────────────────────────────────

let audioContext   = null;
let mediaStream    = null;
let captureStream  = null;
let mediaRecorder  = null;
let recordedChunks = [];
let isRecording    = false;
let timerInterval  = null;
let recordStartTime = 0;
let loopCounter    = 0;
let loopLengthBars = 0;
let currentRecordingTargetBars = 0;
let currentRecordingBpm = DEFAULT_BPM;
let currentRecordingBeatsPerBar = 4;
let shouldNormalizeToTargetBars = false;
let recordAutoStopTimeout = null;
let currentPunchIn = null;
let punchStopTimeout = null;
let playbackPositionInterval = null;
let transportStartTime = null;
let nextLoopCursor = 0;

let masterGainNode = null;
let masterVolume   = 1;

let compressorNode   = null;
let compressorEnabled = true;
let reverbSendGain   = null;
let convolverNode    = null;
let reverbReturnGain = null;
let reverbAmount     = 0;

let inputAnalyser  = null;
let inputMeterFrameId = 0;
let inputSourceNode = null;
let inputChannelSplitter = null;
let inputChannelGainNode = null;
let selectedInputDeviceId = '';
let selectedInputChannel = 'all';
let monitorGainNode  = null;
let monitoringEnabled = false;
let monitorLatencyOffsetMs = 0;

// Tempo / metronome
let bpm              = DEFAULT_BPM;
let beatsPerBar      = 4;
let beatUnit         = 4;
let metronomeEnabled = false;
let countInEnabled   = false;
let quantizeEnabled  = false;
let songModeEnabled  = false;
let songBars         = DEFAULT_SONG_BARS;
let songEndTimeout    = null;
// Number of clicks per beat: 1=quarter, 2=8ths, 3=triplets, 4=16ths.
let metronomeSubdivision = 1;
let metronomeInterval = null;
let metronomeBeatIdx  = 0;
let sceneCrossfadeBars = DEFAULT_SCENE_CROSSFADE_BARS;
let sceneTransitionToken = 0;
let tapTempoTimes     = [];
let leadLoopId        = null;
let firstLoopTempoHandled = false;
let pendingDetectedBpm = null;
let drumSampleBytes = null;
let generatingDrums = false;

let midiAccess = null;
let midiLearnTarget = null;
const midiBindings = {
  record: null,
  playAll: null,
  stopAll: null,
};
const gamepadButtonStates = new Map();

// Undo / redo history for delete-style actions
const undoStack = [];
const redoStack = [];

// Scene snapshots (setlist)
const scenes = Array.from({ length: MAX_SCENES }, () => ({ name: '', snapshot: null }));
let activeSceneIndex = -1;

/**
 * @typedef {Object} LoopFx
 * @property {boolean} filterEnabled
 * @property {'lowpass'|'highpass'} filterType
 * @property {number} filterFreq
 * @property {number} filterQ
 * @property {boolean} distEnabled
 * @property {number} distAmount
 * @property {boolean} delayEnabled
 * @property {number} delayTime
 * @property {number} delayFeedback
 * @property {number} delayMix
 * @property {boolean} reverbEnabled
 * @property {number} reverbMix
 * @property {boolean} gateEnabled
 * @property {number} gateThreshold
 */

/**
 * @typedef {Object} Loop
 * @property {number} id
 * @property {string} name
 * @property {AudioBuffer} audioBuffer
 * @property {AudioBuffer} playbackBuffer
 * @property {AudioBuffer|null} reversedBuffer
 * @property {AudioBuffer|null} transformedBuffer
 * @property {AudioBuffer|null} transformedReversedBuffer
 * @property {number} duration
 * @property {AudioBufferSourceNode|null} node
 * @property {GainNode|null} gainNode
 * @property {StereoPannerNode|null} pannerNode
 * @property {{ lowShelf: BiquadFilterNode, midPeak: BiquadFilterNode, highShelf: BiquadFilterNode }|null} eqNodes
 * @property {boolean} playing
 * @property {boolean} muted
 * @property {boolean} soloed
 * @property {number} volume
 * @property {number} pan
 * @property {number} lowEq
 * @property {number} midEq
 * @property {number} highEq
 * @property {number} playbackRate
 * @property {boolean} followTempo
 * @property {number} tempoBaseBpm
 * @property {number} trimStart
 * @property {number} trimEnd
 * @property {number} fadeIn
 * @property {number} fadeOut
 * @property {number} pitchSemitones
 * @property {boolean} reversed
 * @property {LoopFx} fx
 * @property {object|null} fxChain
 * @property {number} songStartBar
 * @property {number} songBarCount
 * @property {number|null} groupId
 * @property {{ name: string, signature: number } | null} detectedKey
 * @property {number} playStartTime
 * @property {number} playOffset
 * @property {number} playheadFrame
 * @property {HTMLDivElement|null} waveformPlayhead
 * @property {{ source: 'note' | 'cc', channel: number, number: number, mode: 'button' | 'range' } | null} midiToggleBinding
 * @property {{ source: 'note' | 'cc', channel: number, number: number, mode: 'button' | 'range' } | null} midiVolumeBinding
 * @property {Blob|null} sourceBlob
 */

/** @type {Array<Loop>} */
const loops = [];

/**
 * @typedef {Object} Group
 * @property {number} id
 * @property {string} name
 * @property {number} volume
 * @property {boolean} muted
 * @property {boolean} soloed
 */

let groupCounter = 0;
/** @type {Array<Group>} */
const groups = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const permissionBanner   = $('permission-banner');
const btnRequestMic      = $('btn-request-mic');
const sampleLibrary      = $('sample-library');
const inputControls      = $('input-controls');
const inputDeviceSelect  = $('input-device-select');
const inputChannelSelect = $('input-channel-select');
const tempoControls      = $('tempo-controls');
const drumControls       = $('drum-controls');
const bpmInput           = $('bpm-input');
const btnTapTempo        = $('btn-tap-tempo');
const beatsPerBarInput   = $('beats-per-bar-input');
const loopLengthBarsInput = $('loop-length-bars');
const beatUnitInput      = $('beat-unit-input');
const metronomeSubdivisionInput = $('metronome-subdivision-input');
const drumStyleSelect    = $('drum-style');
const btnGenerateDrums   = $('btn-generate-drums');
const metronomeToggle    = $('metronome-toggle');
const countInToggle      = $('count-in-toggle');
const quantizeToggle     = $('quantize-toggle');
const songModeToggle     = $('song-mode-toggle');
const songBarsInput      = $('song-bars-input');
const tempoSuggestion    = $('tempo-suggestion');
const tempoSuggestionText = $('tempo-suggestion-text');
const btnApplyDetectedTempo = $('btn-apply-detected-tempo');
const btnDismissDetectedTempo = $('btn-dismiss-detected-tempo');
const recordControls     = $('record-controls');
const btnRecord          = $('btn-record');
const btnStopRecord      = $('btn-stop-record');
const punchToggle        = $('punch-toggle');
const punchLoopSelect    = $('punch-loop-select');
const punchStartBarInput = $('punch-start-bar');
const punchEndBarInput   = $('punch-end-bar');
const punchBarsTotal     = $('punch-bars-total');
const recordTimer        = $('record-timer');
const statusDot          = $('status-dot');
const statusText         = $('status-text');
const inputMeterFill     = $('input-meter-fill');
const monitoringToggle   = $('monitoring-toggle');
const monitorLatencyInput = $('monitor-latency-offset');
const masterControls     = $('master-controls');
const btnPlayAll         = $('btn-play-all');
const btnStopAll         = $('btn-stop-all');
const btnExportMix       = $('btn-export-mix');
const btnShareSession    = $('btn-share-session');
const exportMidiToggle   = $('export-midi-toggle');
const btnUndo            = $('btn-undo');
const btnRedo            = $('btn-redo');
const btnClearAll        = $('btn-clear-all');
const masterVolumeInput  = $('master-volume');
const reverbSendInput    = $('reverb-send');
const compressorToggle   = $('compressor-toggle');
const scenesSection      = $('scenes-section');
const sceneCrossfadeBarsInput = $('scene-crossfade-bars');
const scenesList         = $('scenes-list');
const playbackPosition   = $('playback-position');
const midiControls       = $('midi-controls');
const midiStatus         = $('midi-status');
const btnEnableMidi      = $('btn-enable-midi');
const loopsSection       = $('loops-section');
const loopsList          = $('loops-list');
const ungroupedLoops     = $('ungrouped-loops');
const btnAddGroup        = $('btn-add-group');
const emptyState         = $('empty-state');
const sampleButtons      = sampleLibrary
  ? Array.from(sampleLibrary.querySelectorAll('[data-builtin-sample]'))
  : [];
const btnThemeToggle     = $('btn-theme-toggle');
const themeToggleIcon    = btnThemeToggle.querySelector('.theme-toggle-icon');
const themeToggleLabel   = btnThemeToggle.querySelector('.theme-toggle-label');
const btnHelp            = $('btn-help');
const helpModal          = $('help-modal');
const helpCloseButton    = $('help-close');
const shortcutList       = $('shortcut-list');
const shortcutEditor     = $('shortcut-editor');
const btnResetShortcuts  = $('btn-reset-shortcuts');
const shortcutRecordHint = $('shortcut-record-inline');
const shortcutUndoHint   = $('shortcut-undo-inline');

const shortcutDefinitions = [
  { action: 'toggleRecord', label: 'Start / stop recording' },
  { action: 'playAll', label: 'Play all loops' },
  { action: 'stopAll', label: 'Stop all loops' },
  { action: 'undoDelete', label: 'Undo the last delete' },
  { action: 'openHelp', label: 'Open help' },
  { action: 'toggleLoop1', label: 'Toggle loop 1' },
  { action: 'toggleLoop2', label: 'Toggle loop 2' },
  { action: 'toggleLoop3', label: 'Toggle loop 3' },
  { action: 'toggleLoop4', label: 'Toggle loop 4' },
  { action: 'toggleLoop5', label: 'Toggle loop 5' },
  { action: 'toggleLoop6', label: 'Toggle loop 6' },
  { action: 'toggleLoop7', label: 'Toggle loop 7' },
  { action: 'toggleLoop8', label: 'Toggle loop 8' },
  { action: 'toggleLoop9', label: 'Toggle loop 9' },
];

let shortcuts = { ...DEFAULT_SHORTCUTS };

function setRangeValueText(input, valueText) {
  input.setAttribute('aria-valuetext', valueText);
}

function formatPercentValueText(v) {
  return `${Math.round(v * 100)} percent`;
}

function formatPanValueText(v) {
  if (Math.abs(v) < 0.02) return 'Center';
  return `${Math.round(Math.abs(v) * 100)} percent ${v < 0 ? 'left' : 'right'}`;
}

function formatPlaybackRateValueText(v) {
  const speed = Number(v.toFixed(2));
  return speed === 1 ? 'Normal speed' : `${speed} times speed`;
}

function formatPitchValueText(v) {
  const semitones = Math.round(v);
  if (semitones === 0) return 'No pitch shift';
  const abs = Math.abs(semitones);
  return `${abs} semitone${abs === 1 ? '' : 's'} ${semitones > 0 ? 'up' : 'down'}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  inputControls.classList.add('hidden');
  recordControls.classList.add('hidden');
  masterControls.classList.add('hidden');
  scenesSection.classList.add('hidden');
  midiControls.classList.add('hidden');
  loopsSection.classList.add('hidden');
  tempoControls.classList.add('hidden');
  drumControls.classList.add('hidden');
  updatePlaybackPosition();

  btnThemeToggle.addEventListener('click', toggleTheme);
  btnRequestMic.addEventListener('click', requestMicrophoneAccess);
  for (const button of sampleButtons) {
    button.addEventListener('click', () => addBuiltinSample(button.dataset.builtinSample));
  }
  inputDeviceSelect.addEventListener('change', onInputDeviceChange);
  inputChannelSelect.addEventListener('change', onInputChannelChange);
  btnRecord.addEventListener('click', handleRecordButton);
  btnStopRecord.addEventListener('click', discardRecording);
  punchToggle.addEventListener('change', updatePunchControls);
  punchLoopSelect.addEventListener('change', syncPunchBarInputs);
  punchStartBarInput.addEventListener('change', syncPunchBarInputs);
  punchEndBarInput.addEventListener('change', syncPunchBarInputs);
  btnPlayAll.addEventListener('click', playAllLoops);
  btnStopAll.addEventListener('click', stopAllLoops);
  btnExportMix.addEventListener('click', exportMix);
  btnShareSession.addEventListener('click', shareSession);
  btnUndo.addEventListener('click', undoDelete);
  btnGenerateDrums.addEventListener('click', generateDrumLoop);
  btnRedo.addEventListener('click', redoDelete);
  btnClearAll.addEventListener('click', clearAllLoops);
  btnEnableMidi.addEventListener('click', enableMidi);

  masterVolumeInput.addEventListener('input', onMasterVolumeChange);
  reverbSendInput.addEventListener('input', onReverbSendChange);
  compressorToggle.addEventListener('change', onCompressorToggle);
  sceneCrossfadeBarsInput.addEventListener('change', onSceneCrossfadeBarsChange);
  setRangeValueText(masterVolumeInput, formatPercentValueText(masterVolume));

  bpmInput.addEventListener('change', onBpmChange);
  btnTapTempo.addEventListener('click', onTapTempo);
  beatsPerBarInput.addEventListener('change', onBeatsPerBarChange);
  loopLengthBarsInput.addEventListener('change', onLoopLengthBarsChange);
  beatUnitInput.addEventListener('change', onBeatUnitChange);
  metronomeSubdivisionInput.addEventListener('change', onMetronomeSubdivisionChange);
  metronomeToggle.addEventListener('change', onMetronomeToggle);
  countInToggle.addEventListener('change', (e) => { countInEnabled = e.target.checked; });
  quantizeToggle.addEventListener('change', (e) => { quantizeEnabled = e.target.checked; });
  songModeToggle.addEventListener('change', onSongModeToggle);
  songBarsInput.addEventListener('change', onSongBarsChange);
  btnApplyDetectedTempo.addEventListener('click', acceptDetectedTempo);
  btnDismissDetectedTempo.addEventListener('click', dismissDetectedTempo);
  monitoringToggle.addEventListener('change', onMonitoringToggle);
  monitorLatencyInput.addEventListener('change', onMonitorLatencyChange);

  btnHelp.addEventListener('click', openHelp);
  helpCloseButton.addEventListener('click', closeHelp);
  helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp(); });
  midiControls.addEventListener('click', onMidiControlsClick);
  loopsList.addEventListener('click', onMidiControlsClick);
  btnResetShortcuts.addEventListener('click', resetShortcuts);

  btnAddGroup.addEventListener('click', addGroup);

  shortcuts = loadShortcutMappings();
  renderShortcutSettings();
  document.addEventListener('keydown', onGlobalKeydown);
  startGamepadPolling();

  updatePunchControls();
  applyTheme(getPreferredTheme());
  followSystemTheme();
  updateMidiStatus('Connect a controller, then click Learn to map pads, buttons, or faders.');
  updateAllMidiBindingLabels();
  syncMonitoringControls();
  updateHistoryButtons();
  renderSceneSlots();
  refreshSceneButtons();
  void restoreSharedSessionFromUrl();
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function getSavedTheme() {
  try {
    const theme = localStorage.getItem(THEME_STORAGE_KEY);
    return theme === 'dark' || theme === 'light' ? theme : null;
  } catch {
    return null;
  }
}

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getPreferredTheme() {
  return getSavedTheme() || getSystemTheme();
}

function applyTheme(theme, persist = false) {
  const currentTheme = theme === 'dark' ? 'dark' : 'light';
  const toggleLabel = currentTheme === 'dark'
    ? 'Switch to light theme'
    : 'Switch to dark theme';

  document.documentElement.dataset.theme = currentTheme;
  themeToggleIcon.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  themeToggleLabel.textContent = toggleLabel;
  btnThemeToggle.title = toggleLabel;
  btnThemeToggle.setAttribute('aria-label', toggleLabel);

  refreshWaveforms();

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, currentTheme);
    } catch {
      // Ignore storage errors so theme switching still works for the session.
    }
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.dataset.theme === 'dark'
    ? 'dark'
    : document.documentElement.dataset.theme === 'light'
      ? 'light'
      : getPreferredTheme();
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark', true);
}

function followSystemTheme() {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', (e) => {
    if (!getSavedTheme()) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

// ─── Microphone access ────────────────────────────────────────────────────────

async function requestMicrophoneAccess() {
  try {
    ensureAudioEngine();

    await refreshInputStream();
    await refreshInputDeviceOptions();

    permissionBanner.classList.add('hidden');
    inputControls.classList.remove('hidden');
    tempoControls.classList.remove('hidden');
    drumControls.classList.remove('hidden');
    recordControls.classList.remove('hidden');
    masterControls.classList.remove('hidden');
    scenesSection.classList.remove('hidden');
    midiControls.classList.remove('hidden');
    loopsSection.classList.remove('hidden');
    updatePlaybackPosition();
    setStatus('Ready. Press ● REC to start recording.');
  } catch (err) {
    showError('Microphone access denied. Please allow microphone access and reload.');
    console.error('getUserMedia error:', err);
  }
}

async function refreshInputStream() {
  const nextCaptureStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
      ...(selectedInputDeviceId ? { deviceId: { exact: selectedInputDeviceId } } : {}),
    },
    video: false,
  });

  const track = nextCaptureStream.getAudioTracks()[0];
  if (track && !selectedInputDeviceId) {
    const settings = track.getSettings ? track.getSettings() : {};
    if (settings.deviceId) selectedInputDeviceId = settings.deviceId;
  }

  stopStream(captureStream);
  captureStream = nextCaptureStream;
  const channelCount = getInputChannelCount(captureStream);
  updateInputChannelOptions(channelCount);
  mediaStream = buildRecordingStream(captureStream, channelCount);
}

async function refreshInputDeviceOptions() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter(device => device.kind === 'audioinput');
  inputDeviceSelect.textContent = '';
  inputDeviceSelect.disabled = audioInputs.length === 0;

  if (audioInputs.length === 0) {
    inputDeviceSelect.appendChild(new Option('Current input', ''));
    inputDeviceSelect.selectedIndex = 0;
    return;
  }

  for (const [index, device] of audioInputs.entries()) {
    const option = new Option(device.label || `Input ${index + 1}`, device.deviceId);
    inputDeviceSelect.appendChild(option);
  }

  if (selectedInputDeviceId && [...inputDeviceSelect.options].some(option => option.value === selectedInputDeviceId)) {
    inputDeviceSelect.value = selectedInputDeviceId;
  } else {
    inputDeviceSelect.selectedIndex = 0;
    selectedInputDeviceId = inputDeviceSelect.value;
  }
}

function getInputChannelCount(stream) {
  const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
  if (!track) return 1;

  const settings = track.getSettings ? track.getSettings() : {};
  const capabilities = track.getCapabilities ? track.getCapabilities() : {};

  const settingCount = typeof settings.channelCount === 'number'
    ? settings.channelCount
    : 0;
  const capabilityCount = typeof capabilities.channelCount === 'number'
    ? capabilities.channelCount
    : (capabilities.channelCount && typeof capabilities.channelCount.max === 'number'
      ? capabilities.channelCount.max
      : 0);

  return Math.max(1, settingCount, capabilityCount);
}

function updateInputChannelOptions(channelCount) {
  if (selectedInputChannel !== 'all') {
    const selectedChannelNumber = parseInt(selectedInputChannel, 10);
    if (isNaN(selectedChannelNumber) || selectedChannelNumber < 1 || selectedChannelNumber > channelCount) {
      selectedInputChannel = 'all';
    }
  }

  inputChannelSelect.textContent = '';
  inputChannelSelect.appendChild(new Option('All channels', 'all'));
  for (let channel = 1; channel <= channelCount; channel++) {
    inputChannelSelect.appendChild(new Option(`Channel ${channel}`, String(channel)));
  }
  inputChannelSelect.value = selectedInputChannel;
}

function buildRecordingStream(stream, channelCount) {
  teardownInputRouting();

  inputSourceNode = audioContext.createMediaStreamSource(stream);
  if (selectedInputChannel === 'all' || channelCount <= 1) {
    setInputAnalyserSource(inputSourceNode);
    return stream;
  }

  inputChannelSplitter = audioContext.createChannelSplitter(channelCount);
  inputChannelGainNode = audioContext.createGain();
  inputSourceNode.connect(inputChannelSplitter);
  inputChannelSplitter.connect(inputChannelGainNode, parseInt(selectedInputChannel, 10) - 1);

  const destination = audioContext.createMediaStreamDestination();
  inputChannelGainNode.connect(destination);
  setInputAnalyserSource(inputChannelGainNode);
  return destination.stream;
}

function teardownInputRouting() {
  if (inputMeterFrameId) {
    cancelAnimationFrame(inputMeterFrameId);
    inputMeterFrameId = 0;
  }
  try { inputSourceNode && inputSourceNode.disconnect(); } catch { /* ignore */ }
  try { inputChannelSplitter && inputChannelSplitter.disconnect(); } catch { /* ignore */ }
  try { inputChannelGainNode && inputChannelGainNode.disconnect(); } catch { /* ignore */ }
  try { inputAnalyser && inputAnalyser.disconnect(); } catch { /* ignore */ }
  inputSourceNode = null;
  inputChannelSplitter = null;
  inputChannelGainNode = null;
  inputAnalyser = null;
  if (inputMeterFill) inputMeterFill.style.width = '0%';
}

function setInputAnalyserSource(sourceNode) {
  inputAnalyser = audioContext.createAnalyser();
  inputAnalyser.fftSize = 512;
  sourceNode.connect(inputAnalyser);

  if (!monitorGainNode) {
    monitorGainNode = audioContext.createGain();
    monitorGainNode.gain.value = 0;
    monitorGainNode.connect(masterGainNode);
  }
  sourceNode.connect(monitorGainNode);
  updateMonitoringState();

  startInputMeter();
}

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

async function onInputDeviceChange(e) {
  if (isRecording) {
    inputDeviceSelect.value = selectedInputDeviceId;
    showInfo('Stop recording before switching inputs.');
    return;
  }

  const previousDeviceId = selectedInputDeviceId;
  selectedInputDeviceId = e.target.value;

  try {
    await refreshInputStream();
    await refreshInputDeviceOptions();
    setStatus('Input updated. Press ● REC to start recording.');
  } catch (err) {
    selectedInputDeviceId = previousDeviceId;
    inputDeviceSelect.value = previousDeviceId;
    showError('Could not switch input: ' + err.message);
    console.error('input device error:', err);
  }
}

function onInputChannelChange(e) {
  if (isRecording) {
    inputChannelSelect.value = selectedInputChannel;
    showInfo('Stop recording before switching channels.');
    return;
  }

  selectedInputChannel = e.target.value;
  mediaStream = buildRecordingStream(captureStream, getInputChannelCount(captureStream));
  setStatus('Input updated. Press ● REC to start recording.');
}

function ensureAudioEngine() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (!masterGainNode) {
    masterGainNode = audioContext.createGain();
    masterGainNode.gain.value = masterVolume;

    // Master bus: masterGain → compressor → destination
    compressorNode = audioContext.createDynamicsCompressor();
    compressorNode.threshold.value = compressorEnabled ? -24 : 0;
    compressorNode.knee.value      = 30;
    compressorNode.ratio.value     = compressorEnabled ? 4 : 1;
    compressorNode.attack.value    = 0.003;
    compressorNode.release.value   = 0.25;

    masterGainNode.connect(compressorNode);
    compressorNode.connect(audioContext.destination);

    // Global reverb send: masterGain → reverbSendGain → convolver → reverbReturnGain → compressor
    reverbSendGain = audioContext.createGain();
    reverbSendGain.gain.value = reverbAmount;
    convolverNode = audioContext.createConvolver();
    convolverNode.buffer = createReverbIR(audioContext);
    reverbReturnGain = audioContext.createGain();
    reverbReturnGain.gain.value = 1;
    masterGainNode.connect(reverbSendGain);
    reverbSendGain.connect(convolverNode);
    convolverNode.connect(reverbReturnGain);
    reverbReturnGain.connect(compressorNode);
  }
}

// ─── Input level meter ────────────────────────────────────────────────────────

function startInputMeter() {
  if (!inputAnalyser) return;
  if (inputMeterFrameId) cancelAnimationFrame(inputMeterFrameId);
  const analyser = inputAnalyser;
  const buf = new Uint8Array(analyser.fftSize);
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128);
      if (v > peak) peak = v;
    }
    const pct = Math.min(100, (peak / 128) * 100 * 1.4);
    if (inputMeterFill) inputMeterFill.style.width = pct.toFixed(1) + '%';
    inputMeterFrameId = requestAnimationFrame(tick);
  };
  tick();
}

function onMonitoringToggle(e) {
  monitoringEnabled = e.target.checked;
  if (monitoringEnabled && audioContext && audioContext.state === 'suspended') {
    audioContext.resume();
  }
  updateMonitoringState();
}

function onMonitorLatencyChange() {
  let v = parseInt(monitorLatencyInput.value, 10);
  if (isNaN(v)) v = 0;
  v = Math.max(MIN_MONITOR_OFFSET_MS, Math.min(MAX_MONITOR_OFFSET_MS, v));
  monitorLatencyOffsetMs = v;
  monitorLatencyInput.value = String(v);
}

function syncMonitoringControls() {
  monitoringToggle.checked = monitoringEnabled;
  monitorLatencyInput.value = String(monitorLatencyOffsetMs);
  monitorLatencyInput.disabled = !monitoringEnabled;
}

function updateMonitoringState() {
  syncMonitoringControls();
  if (!audioContext || !monitorGainNode) return;
  monitorGainNode.gain.setTargetAtTime(monitoringEnabled ? 1 : 0, audioContext.currentTime, 0.01);
}

// ─── Recording ────────────────────────────────────────────────────────────────

function handleRecordButton() {
  if (isRecording) {
    stopRecording();
  } else {
    beginRecording();
  }
}

async function beginRecording() {
  if (!mediaStream) return;
  const punchIn = getSelectedPunchIn();
  if (countInEnabled) {
    await doCountIn();
  }
  startRecording(punchIn);
}

function doCountIn() {
  return new Promise((resolve) => {
    const intervalMs = getBeatIntervalMs();
    let beat = 1;
    setStatus(`Count-in… ${beat}`);
    playClick('downbeat');
    const id = setInterval(() => {
      beat++;
      if (beat > beatsPerBar) {
        clearInterval(id);
        resolve();
        return;
      }
      playClick('beat');
      setStatus(`Count-in… ${beat}`);
    }, intervalMs);
  });
}

function startRecording(punchIn = null) {
  if (!mediaStream) return;

  recordedChunks = [];
  const mimeType = getSupportedMimeType();
  try {
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    showError('Could not start recording: ' + err.message);
    return;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start(100);

  currentRecordingTargetBars = loopLengthBars;
  currentRecordingBpm = bpm;
  currentRecordingBeatsPerBar = beatsPerBar;
  shouldNormalizeToTargetBars = false;
  isRecording = true;
  currentPunchIn = punchIn;
  recordStartTime = Date.now();
  scheduleRecordingAutoStop();

  btnRecord.textContent = '■ STOP';
  btnRecord.classList.add('recording');
  btnStopRecord.disabled = false;
  loopLengthBarsInput.disabled = true;
  statusDot.classList.add('recording');
  clearPunchStopTimer();
  if (punchIn) {
    setStatus(`Punching into "${punchIn.loop.name}" (bars ${punchIn.startBar}-${punchIn.endBar})…`);
    punchStopTimeout = setTimeout(() => {
      if (isRecording) stopRecording();
    }, punchIn.durationSeconds * 1000);
  } else if (currentRecordingTargetBars > 0) {
    setStatus(`Recording… auto-stop at ${formatBars(currentRecordingTargetBars)}.`);
  } else {
    setStatus('Recording…');
  }
  startTimer();
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  clearRecordingAutoStop();
  mediaRecorder.stop();
  isRecording = false;
  clearPunchStopTimer();
  clearInterval(timerInterval);

  btnRecord.textContent = '● REC';
  btnRecord.classList.remove('recording');
  btnStopRecord.disabled = true;
  loopLengthBarsInput.disabled = false;
  statusDot.classList.remove('recording');
  setStatus('Processing loop…');
}

function discardRecording() {
  if (!isRecording || !mediaRecorder) return;
  clearRecordingAutoStop();
  mediaRecorder.onstop = null;
  try { mediaRecorder.stop(); } catch { /* ignore */ }
  recordedChunks = [];
  isRecording = false;
  currentPunchIn = null;
  clearPunchStopTimer();
  clearInterval(timerInterval);
  resetRecordingTarget();

  btnRecord.textContent = '● REC';
  btnRecord.classList.remove('recording');
  btnStopRecord.disabled = true;
  loopLengthBarsInput.disabled = false;
  statusDot.classList.remove('recording');
  resetTimer();
  setStatus('Recording discarded. Press ● REC to try again.');
}

async function onRecordingStop() {
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(recordedChunks, { type: mimeType });
  recordedChunks = [];
  const punchIn = currentPunchIn;
  currentPunchIn = null;

  try {
    const arrayBuffer = await blob.arrayBuffer();
    let audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    if (monitorLatencyOffsetMs !== 0) {
      // A positive user-facing compensation value should pull the recorded take earlier.
      audioBuffer = _offsetBuffer(audioBuffer, -monitorLatencyOffsetMs / 1000, audioContext);
    }
    if (punchIn) {
      // Punch-in uses an explicit target bar range, so preserve the take as
      // recorded instead of re-quantizing it to a fresh loop length.
      applyPunchInToLoop(punchIn.loop, audioBuffer, punchIn);
      setStatus(`Punch-in applied to "${punchIn.loop.name}" (bars ${punchIn.startBar}-${punchIn.endBar}).`);
    } else {
      let suggestedTempo = false;
      if (loops.length === 0 && !firstLoopTempoHandled) {
        suggestedTempo = maybeSuggestTempo(audioBuffer);
      }
      const normalizeToBars = shouldNormalizeToTargetBars && currentRecordingTargetBars > 0;
      if (normalizeToBars) {
        audioBuffer = fitBufferToBars(audioBuffer, currentRecordingTargetBars);
      } else if (quantizeEnabled) {
        audioBuffer = quantizeBuffer(audioBuffer);
      }
      const bufferTransformed = normalizeToBars || quantizeEnabled;
      const detectedKey = detectLoopKey(audioBuffer);
      const shouldWarn = shouldWarnAboutKeyClash(
        detectedKey,
        loops.map((loop) => loop.detectedKey),
      );
      addLoop(audioBuffer, {
        sourceBlob: bufferTransformed ? audioBufferToWav(audioBuffer) : blob,
        detectedKey,
      });
      if (shouldWarn && detectedKey) {
        showWarning(`New loop sounds like ${detectedKey.name}, which may clash with your existing loops.`);
        setStatus(`Loop added with warning: detected key ${detectedKey.name}.`);
      } else if (detectedKey) {
        setStatus(`Loop added! Detected key: ${detectedKey.name}. Press ● REC to record another.`);
      } else if (!suggestedTempo) {
        setStatus('Loop added! Key unclear. Press ● REC to record another.');
      }
    }
  } catch (err) {
    showError('Could not decode audio: ' + err.message);
    console.error('decodeAudioData error:', err);
    setStatus('Ready. Press ● REC to start recording.');
  }
  resetRecordingTarget();
  resetTimer();
}

// ─── Quantize (snap loop length to whole bars) ───────────────────────────────

function quantizeBuffer(buffer) {
  return _quantizeBuffer(buffer, { bpm, beatsPerBar, beatUnit, audioContext });
}

function applyPunchInToLoop(loop, takeBuffer, punchIn) {
  loop.audioBuffer = _applyPunchIn(loop.audioBuffer, takeBuffer, {
    startBar: punchIn.startBar,
    endBar: punchIn.endBar,
    bpm,
    beatsPerBar,
    audioContext,
  });
  loop.reversedBuffer = null;
  loop.duration = loop.audioBuffer.duration;
  updateLoopCard(loop);
  refreshLoopPlayback(loop);
  syncPunchBarInputs();
}

function fitBufferToBars(buffer, bars) {
  return _fitBufferToBars(buffer, {
    bars,
    bpm: currentRecordingBpm,
    beatsPerBar: currentRecordingBeatsPerBar,
    audioContext,
  });
}

function barsToDurationMs(bars, currentBpm, currentBeatsPerBar) {
  return Math.round(_barsToDurationSeconds(bars, {
    bpm: currentBpm,
    beatsPerBar: currentBeatsPerBar,
  }) * 1000);
}

// ─── Loop management ──────────────────────────────────────────────────────────

function addLoop(audioBuffer, options = {}) {
  loopCounter++;
  const name = (options.name || '').trim() || `Loop ${loopCounter}`;
  /** @type {Loop} */
  const loop = {
    id: loopCounter,
    name,
    audioBuffer,
    playbackBuffer: audioBuffer,
    reversedBuffer: null,
    transformedBuffer: null,
    transformedReversedBuffer: null,
    duration: audioBuffer.duration,
    node: null,
    gainNode: null,
    pannerNode: null,
    eqNodes: null,
    playing: false,
    muted: !!options.muted,
    soloed: !!options.soloed,
    volume: options.volume ?? 1,
    pan: options.pan ?? 0,
    lowEq: options.lowEq ?? 0,
    midEq: options.midEq ?? 0,
    highEq: options.highEq ?? 0,
    playbackRate: options.playbackRate ?? 1,
    followTempo: !!options.followTempo,
    tempoBaseBpm: options.tempoBaseBpm ?? bpm,
    trimStart: options.trimStart ?? 0,
    trimEnd: options.trimEnd ?? audioBuffer.duration,
    fadeIn: options.fadeIn ?? 0,
    fadeOut: options.fadeOut ?? 0,
    pitchSemitones: options.pitchSemitones ?? 0,
    reversed: !!options.reversed,
    songStartBar: options.songStartBar ?? 1,
    songBarCount: options.songBarCount ?? songBars,
    groupId: options.groupId ?? null,
    detectedKey: options.detectedKey ?? null,
    playStartTime: 0,
    playOffset: 0,
    playheadFrame: 0,
    waveformPlayhead: null,
    sourceBlob: options.sourceBlob || null,
    midiToggleBinding: null,
    midiVolumeBinding: null,
    fx: {
      filterEnabled: false,
      filterType: 'lowpass',
      filterFreq: 2000,
      filterQ: 1,
      distEnabled: false,
      distAmount: 100,
      delayEnabled: false,
      delayTime: 0.3,
      delayFeedback: 0.4,
      delayMix: 0.4,
      reverbEnabled: false,
      reverbMix: 0.3,
      gateEnabled: false,
      gateThreshold: -50,
    },
    fxChain: null,
  };
  loops.push(loop);
  renderLoop(loop);
  updateEmptyState();
  refreshPunchLoopOptions();
  updateHistoryButtons();
  refreshSceneButtons();
}

async function addBuiltinSample(sample) {
  try {
    await ensureAudioEngine();
    const label = sampleLabel(sample);
    const loop = createBuiltinSampleLoop(audioContext, { sample, bpm, beatsPerBar });
    addLoop(loop, { name: label });
    showLoopWorkspace(false);
    showInfo(`Added ${label} loop from the sample library.`);
  } catch (err) {
    showError('Could not add sample: ' + err.message);
    console.error('sample library error:', err);
  }
}

/** Effective gain for a loop accounting for mute/solo/volume, group state, and ducking. */
function effectiveGain(loop) {
  return computeEffectiveGain(loop, loops, groups, {
    leadLoopId,
    duckGain: DUCK_GAIN,
  });
}

function isLeadLoop(loop) {
  return leadLoopId != null && loop.id === leadLoopId;
}

function updateLeadButton(card, loop) {
  const isLead = isLeadLoop(loop);
  card.classList.toggle('lead', isLead);
  const btn = card.querySelector('.btn-lead');
  if (!btn) return;
  btn.classList.toggle('active', isLead);
  btn.setAttribute('aria-pressed', isLead ? 'true' : 'false');
  btn.title = isLead ? 'Unset lead' : 'Set as lead';
  btn.setAttribute('aria-label', isLead ? 'Unset lead loop' : 'Set as lead loop');
}

function refreshLeadUi() {
  for (const loop of loops) {
    const card = document.getElementById(`loop-card-${loop.id}`);
    if (card) updateLeadButton(card, loop);
  }
}

function toggleLead(loop) {
  // Clicking the active lead clears lead mode; otherwise this loop becomes lead.
  leadLoopId = isLeadLoop(loop) ? null : loop.id;
  refreshLeadUi();
  refreshAllGains();
}

function createEqNodes(context, loop) {
  const lowShelf = context.createBiquadFilter();
  lowShelf.type = 'lowshelf';
  lowShelf.frequency.value = LOW_EQ_FREQUENCY;
  lowShelf.gain.value = loop.lowEq;

  const midPeak = context.createBiquadFilter();
  midPeak.type = 'peaking';
  midPeak.frequency.value = MID_EQ_FREQUENCY;
  midPeak.Q.value = MID_EQ_Q;
  midPeak.gain.value = loop.midEq;

  const highShelf = context.createBiquadFilter();
  highShelf.type = 'highshelf';
  highShelf.frequency.value = HIGH_EQ_FREQUENCY;
  highShelf.gain.value = loop.highEq;

  lowShelf.connect(midPeak);
  midPeak.connect(highShelf);

  return { lowShelf, midPeak, highShelf };
}

function maybeSuggestTempo(audioBuffer) {
  firstLoopTempoHandled = true;
  const detectedBpm = estimateTempo(audioBuffer, { minBpm: MIN_BPM, maxBpm: MAX_BPM });
  if (!detectedBpm) return false;
  if (detectedBpm === bpm) {
    return false;
  }

  pendingDetectedBpm = detectedBpm;
  tempoSuggestionText.textContent = `Detected ${detectedBpm} BPM from your first loop. Use it for this session?`;
  tempoSuggestion.classList.remove('hidden');
  setStatus('Review the suggested BPM for your first loop.');
  return true;
}

function refreshAllGains() {
  if (!audioContext) return;
  const t = audioContext.currentTime;
  for (const l of loops) {
    if (l.gainNode) {
      l.gainNode.gain.setTargetAtTime(effectiveGain(l), t, 0.01);
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampLoopEdits(loop) {
  const minDuration = 1 / loop.audioBuffer.sampleRate;
  const totalDuration = loop.audioBuffer.duration;
  loop.trimStart = clamp(loop.trimStart, 0, Math.max(0, totalDuration - minDuration));
  loop.trimEnd = clamp(loop.trimEnd, loop.trimStart + minDuration, totalDuration);
  loop.duration = Math.max(minDuration, loop.trimEnd - loop.trimStart);
  loop.fadeIn = clamp(loop.fadeIn, 0, loop.duration);
  loop.fadeOut = clamp(loop.fadeOut, 0, loop.duration);
}

function rebuildLoopBuffer(loop) {
  clampLoopEdits(loop);
  if (
    loop.trimStart === 0
    && loop.trimEnd === loop.audioBuffer.duration
    && loop.fadeIn === 0
    && loop.fadeOut === 0
  ) {
    loop.playbackBuffer = loop.audioBuffer;
  } else {
    loop.playbackBuffer = buildLoopBuffer(loop.audioBuffer, {
      trimStart: loop.trimStart,
      trimEnd: loop.trimEnd,
      fadeIn: loop.fadeIn,
      fadeOut: loop.fadeOut,
      audioContext,
    });
  }
  loop.reversedBuffer = null;
  invalidateLoopProcessing(loop);
}

function refreshLoopBuffer(loop) {
  const wasPlaying = loop.playing;
  if (wasPlaying) stopLoop(loop);
  rebuildLoopBuffer(loop);
  if (wasPlaying) {
    setTimeout(
      () => playLoop(loop),
      Math.ceil(FADE_TIME * 1000 * LOOP_RESTART_DELAY_MULTIPLIER),
    );
  }
}

function getPlaybackBuffer(loop) {
  const baseBuffer = getTransformedBuffer(loop);
  if (!loop.reversed) return baseBuffer;
  if (!loop.transformedReversedBuffer) {
    loop.transformedReversedBuffer = reverseBuffer(baseBuffer);
  }
  return loop.transformedReversedBuffer;
}

function normalizeLoopOffset(loop, offset) {
  if (!Number.isFinite(loop.duration) || loop.duration <= 0) return 0;
  const normalized = offset % loop.duration;
  return normalized < 0 ? normalized + loop.duration : normalized;
}

function getLoopPlaybackPosition(loop) {
  const baseOffset = normalizeLoopOffset(loop, loop.playOffset);
  if (!loop.playing || !audioContext) return baseOffset;
  const elapsed = Math.max(0, audioContext.currentTime - loop.playStartTime);
  return normalizeLoopOffset(loop, baseOffset + elapsed * loop.playbackRate);
}

function updateLoopPlayhead(loop, offset = getLoopPlaybackPosition(loop)) {
  if (!loop.waveformPlayhead) return;
  const progress = loop.duration > 0 ? normalizeLoopOffset(loop, offset) / loop.duration : 0;
  loop.waveformPlayhead.style.left = `${(progress * 100).toFixed(3)}%`;
  loop.waveformPlayhead.classList.toggle('active', loop.playing || progress > 0);
}

function stopLoopPlayheadAnimation(loop) {
  if (loop.playheadFrame) {
    cancelAnimationFrame(loop.playheadFrame);
    loop.playheadFrame = 0;
  }
}

function startLoopPlayheadAnimation(loop) {
  stopLoopPlayheadAnimation(loop);
  const tick = () => {
    if (!loop.playing) return;
    updateLoopPlayhead(loop);
    loop.playheadFrame = requestAnimationFrame(tick);
  };
  loop.playheadFrame = requestAnimationFrame(tick);
}

function reverseBuffer(buffer) {
  return _reverseBuffer(buffer, audioContext);
}

// ─── Effects chain ────────────────────────────────────────────────────────────

/**
 * Build and wire an effects chain for a loop using the given AudioContext.
 *
 * Returns an object whose `input` and `output` GainNodes should be spliced
 * between the source/panner node and the gain (volume) node.
 *
 * Audio signal path:
 *   input → gateAnalyser → gate → filter → distortion
 *   distortion → delayBus (dry)
 *   distortion → delay → delayFeedback ↺ → delayWet → delayBus (wet)
 *   delayBus → output (dry reverb path)
 *   delayBus → convolver → reverbWet → output (wet reverb path)
 *
 * @param {Loop} loop
 * @param {AudioContext|OfflineAudioContext} ctx
 * @returns {object} fxChain
 */
function buildFxChain(loop, ctx) {
  const { fx } = loop;

  // ── Gate ──────────────────────────────────────────────────────────────────
  const gateAnalyser = ctx.createAnalyser();
  gateAnalyser.fftSize = 1024;
  const gate = ctx.createGain();
  gate.gain.value = 1; // default open

  // ── Filter ────────────────────────────────────────────────────────────────
  const filter = ctx.createBiquadFilter();
  filter.type = fx.filterEnabled ? fx.filterType : 'allpass';
  filter.frequency.value = fx.filterFreq;
  filter.Q.value = fx.filterQ;

  // ── Distortion ────────────────────────────────────────────────────────────
  const distortion = ctx.createWaveShaper();
  distortion.oversample = '4x';
  distortion.curve = fx.distEnabled ? makeDistortionCurve(fx.distAmount) : null;

  // ── Delay ─────────────────────────────────────────────────────────────────
  const delayBus = ctx.createGain(); // sums dry + delay-wet
  delayBus.gain.value = 1;
  const delay = ctx.createDelay(4.0);
  delay.delayTime.value = fx.delayTime;
  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = fx.delayEnabled ? fx.delayFeedback : 0;
  const delayWet = ctx.createGain();
  delayWet.gain.value = fx.delayEnabled ? fx.delayMix : 0;

  // ── Reverb ────────────────────────────────────────────────────────────────
  const convolver = ctx.createConvolver();
  convolver.buffer = makeReverbIR(ctx);
  const reverbWet = ctx.createGain();
  reverbWet.gain.value = fx.reverbEnabled ? fx.reverbMix : 0;

  // ── Input / Output buses ───────────────────────────────────────────────────
  const input = ctx.createGain();
  input.gain.value = 1;
  const output = ctx.createGain(); // sums dry-reverb + wet-reverb
  output.gain.value = 1;

  // ── Wiring ────────────────────────────────────────────────────────────────
  input.connect(gateAnalyser);
  gateAnalyser.connect(gate);
  gate.connect(filter);
  filter.connect(distortion);

  // Delay section
  distortion.connect(delayBus);          // dry pass-through
  distortion.connect(delay);             // feed delay
  delay.connect(delayFeedback);          // feedback tap
  delayFeedback.connect(delay);          // feedback loop
  delay.connect(delayWet);              // wet tap
  delayWet.connect(delayBus);           // merge wet into bus

  // Reverb section
  delayBus.connect(output);             // dry pass-through
  delayBus.connect(convolver);          // feed reverb
  convolver.connect(reverbWet);         // wet tap
  reverbWet.connect(output);            // merge wet into output

  // ── Gate polling (live AudioContext only) ─────────────────────────────────
  const gateState = { rafId: null };
  if (typeof requestAnimationFrame === 'function' && ctx === audioContext) {
    const buf = new Float32Array(gateAnalyser.fftSize);
    const tick = () => {
      if (!loop.fxChain || !loop.playing) return;
      if (fx.gateEnabled) {
        gateAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(rms < 1e-10 ? 1e-10 : rms);
        const open = db >= fx.gateThreshold;
        gate.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, 0.02);
      } else {
        gate.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
      }
      gateState.rafId = requestAnimationFrame(tick);
    };
    gateState.rafId = requestAnimationFrame(tick);
  }

  return {
    input, output,
    gateAnalyser, gate, gateState,
    filter, distortion,
    delay, delayFeedback, delayWet, delayBus,
    convolver, reverbWet,
  };
}

// ─── Effect setters ───────────────────────────────────────────────────────────

function setFxFilterEnabled(loop, enabled) {
  loop.fx.filterEnabled = enabled;
  if (loop.fxChain) {
    loop.fxChain.filter.type = enabled ? loop.fx.filterType : 'allpass';
  }
}

function setFxFilterType(loop, type) {
  loop.fx.filterType = type;
  if (loop.fxChain && loop.fx.filterEnabled) {
    loop.fxChain.filter.type = type;
  }
}

function setFxFilterFreq(loop, freq) {
  loop.fx.filterFreq = freq;
  if (loop.fxChain) {
    loop.fxChain.filter.frequency.setTargetAtTime(freq, audioContext.currentTime, 0.01);
  }
}

function setFxFilterQ(loop, q) {
  loop.fx.filterQ = q;
  if (loop.fxChain) {
    loop.fxChain.filter.Q.setTargetAtTime(q, audioContext.currentTime, 0.01);
  }
}

function setFxDistEnabled(loop, enabled) {
  loop.fx.distEnabled = enabled;
  if (loop.fxChain) {
    loop.fxChain.distortion.curve = enabled
      ? makeDistortionCurve(loop.fx.distAmount)
      : null;
  }
}

function setFxDistAmount(loop, amount) {
  loop.fx.distAmount = amount;
  if (loop.fxChain && loop.fx.distEnabled) {
    loop.fxChain.distortion.curve = makeDistortionCurve(amount);
  }
}

function setFxDelayEnabled(loop, enabled) {
  loop.fx.delayEnabled = enabled;
  if (loop.fxChain) {
    const t = audioContext.currentTime;
    loop.fxChain.delayFeedback.gain.setTargetAtTime(
      enabled ? loop.fx.delayFeedback : 0, t, 0.01,
    );
    loop.fxChain.delayWet.gain.setTargetAtTime(
      enabled ? loop.fx.delayMix : 0, t, 0.01,
    );
  }
}

function setFxDelayTime(loop, time) {
  loop.fx.delayTime = time;
  if (loop.fxChain) {
    loop.fxChain.delay.delayTime.setTargetAtTime(time, audioContext.currentTime, 0.01);
  }
}

function setFxDelayFeedback(loop, fb) {
  loop.fx.delayFeedback = fb;
  if (loop.fxChain && loop.fx.delayEnabled) {
    loop.fxChain.delayFeedback.gain.setTargetAtTime(fb, audioContext.currentTime, 0.01);
  }
}

function setFxDelayMix(loop, mix) {
  loop.fx.delayMix = mix;
  if (loop.fxChain && loop.fx.delayEnabled) {
    loop.fxChain.delayWet.gain.setTargetAtTime(mix, audioContext.currentTime, 0.01);
  }
}

function setFxReverbEnabled(loop, enabled) {
  loop.fx.reverbEnabled = enabled;
  if (loop.fxChain) {
    loop.fxChain.reverbWet.gain.setTargetAtTime(
      enabled ? loop.fx.reverbMix : 0, audioContext.currentTime, 0.01,
    );
  }
}

function setFxReverbMix(loop, mix) {
  loop.fx.reverbMix = mix;
  if (loop.fxChain && loop.fx.reverbEnabled) {
    loop.fxChain.reverbWet.gain.setTargetAtTime(mix, audioContext.currentTime, 0.01);
  }
}

function setFxGateEnabled(loop, enabled) {
  loop.fx.gateEnabled = enabled;
  if (loop.fxChain && !enabled) {
    loop.fxChain.gate.gain.setTargetAtTime(1, audioContext.currentTime, 0.02);
  }
}

function setFxGateThreshold(loop, threshold) {
  loop.fx.gateThreshold = threshold;
}

// ─── Playback ─────────────────────────────────────────────────────────────────

function rampLoopGain(loop, targetGain, durationSeconds) {
  if (!loop.gainNode || !audioContext) return;
  const now = audioContext.currentTime;
  loop.gainNode.gain.cancelScheduledValues(now);
  loop.gainNode.gain.setValueAtTime(loop.gainNode.gain.value, now);
  loop.gainNode.gain.linearRampToValueAtTime(targetGain, now + durationSeconds);
}

function hasActiveOrScheduledPlayback(loop) {
  return loop.playing || !!loop.node;
}

function getLoopPlaybackRate(loop) {
  return computeLoopPlaybackRate(loop, bpm);
}

function updateLoopPlaybackRate(loop) {
  if (loop.node) {
    const factor = loop.followTempo && loop.tempoBaseBpm > 0 ? bpm / loop.tempoBaseBpm : 1;
    loop.node.playbackRate.setTargetAtTime(factor, audioContext.currentTime, 0.01);
  }
}

function updateLoopTempoUi(loop) {
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (!card) return;

  const toggle = card.querySelector('.follow-tempo-toggle input');
  if (toggle) toggle.checked = loop.followTempo;

  const valueEl = card.querySelector('.loop-tempo-factor');
  if (valueEl) {
    valueEl.textContent = loop.followTempo
      ? `Tempo ${getLoopPlaybackRate(loop).toFixed(2)}×`
      : 'Tempo off';
  }
}

function transformBuffer(buffer, speed, pitchSemitones) {
  return _transformBuffer(buffer, { speed, pitchSemitones, audioContext });
}

function invalidateLoopProcessing(loop) {
  loop.transformedBuffer = null;
  loop.transformedReversedBuffer = null;
}

function getTransformedBuffer(loop) {
  if (!loop.transformedBuffer) {
    if (Math.abs(loop.playbackRate - 1) < 1e-6 && Math.abs(loop.pitchSemitones) < 1e-6) {
      loop.transformedBuffer = loop.playbackBuffer;
    } else {
      loop.transformedBuffer = transformBuffer(loop.playbackBuffer, loop.playbackRate, loop.pitchSemitones);
    }
  }
  return loop.transformedBuffer;
}

function restartLoopPlayback(loop) {
  if (!loop.playing) return;
  loop.restartToken = (loop.restartToken || 0) + 1;
  const restartToken = loop.restartToken;
  stopLoop(loop, { preserveRestart: true });
  setTimeout(() => {
    if (loop.restartToken === restartToken) playLoop(loop);
  }, Math.ceil(FADE_TIME * 1000 * 6));
}

function getLoopStartOffset(loop, buffer, startTime) {
  if (transportStartTime === null || buffer.duration <= 0) return 0;
  const elapsed = Math.max(0, startTime - transportStartTime);
  return (elapsed * loop.playbackRate) % buffer.duration;
}

function hasActiveLoops() {
  return loops.some(loop => loop.playing);
}

function startPlaybackPositionTimer() {
  if (playbackPositionInterval || !playbackPosition) return;
  playbackPositionInterval = setInterval(updatePlaybackPosition, POSITION_UPDATE_INTERVAL_MS);
}

function stopPlaybackPositionTimer() {
  if (!playbackPositionInterval) return;
  clearInterval(playbackPositionInterval);
  playbackPositionInterval = null;
}

function updatePlaybackPosition() {
  if (!playbackPosition) return;
  if (!audioContext || transportStartTime === null || !hasActiveLoops()) {
    playbackPosition.textContent = IDLE_PLAYBACK_POSITION;
    return;
  }
  const elapsed = Math.max(0, audioContext.currentTime - transportStartTime);
  playbackPosition.textContent = `Now playing: ${formatBarBeatPosition(elapsed, bpm, beatsPerBar)}`;
}

function playLoop(loop, arg = {}) {
  const options = typeof arg === 'number' ? { startOffset: arg } : (arg || {});
  if (!audioContext || hasActiveOrScheduledPlayback(loop)) return;
  if (audioContext.state === 'suspended') audioContext.resume();
  // Song mode schedules a bar-aligned start (options.when) and an automatic
  // stop after a set duration (options.stopAfter); both fall back gracefully.
  const startAt = options.when ?? options.startAt ?? (audioContext.currentTime + 0.02);
  const stopAfter = typeof options.stopAfter === 'number' ? options.stopAfter : null;
  const isNewTransport = transportStartTime === null;
  if (isNewTransport) {
    transportStartTime = startAt;
  }

  const {
    fadeDuration = FADE_TIME,
    initialGain = 0,
    targetGain = effectiveGain(loop),
    useLinearFade = false,
    skipRefresh = false,
  } = options;

  const gainNode = audioContext.createGain();
  gainNode.gain.value = initialGain;
  if (useLinearFade) {
    gainNode.gain.setValueAtTime(initialGain, startAt);
    gainNode.gain.linearRampToValueAtTime(targetGain, startAt + fadeDuration);
  } else {
    gainNode.gain.setTargetAtTime(targetGain, startAt, fadeDuration);
  }

  const pannerNode = audioContext.createStereoPanner
    ? audioContext.createStereoPanner()
    : null;
  if (pannerNode) pannerNode.pan.value = loop.pan;

  const sourceNode = audioContext.createBufferSource();
  const buffer = getPlaybackBuffer(loop);
  sourceNode.buffer = buffer;
  sourceNode.loop = true;
  sourceNode.playbackRate.value = loop.followTempo && loop.tempoBaseBpm > 0
    ? bpm / loop.tempoBaseBpm
    : 1;
  const eqNodes = createEqNodes(audioContext, loop);

  // Build effects chain and wire: source → panner → fxChain → gain → master
  const fxChain = buildFxChain(loop, audioContext);

  if (pannerNode) {
    sourceNode.connect(eqNodes.lowShelf);
    eqNodes.highShelf.connect(pannerNode);
    pannerNode.connect(fxChain.input);
  } else {
    sourceNode.connect(eqNodes.lowShelf);
    eqNodes.highShelf.connect(fxChain.input);
  }
  fxChain.output.connect(gainNode);
  gainNode.connect(masterGainNode);

  let offset;
  if (options.startOffset != null) {
    offset = normalizeLoopOffset(loop, options.startOffset);
  } else if (options.when != null || options.startAt != null) {
    offset = normalizeLoopOffset(loop, getLoopStartOffset(loop, buffer, startAt));
  } else {
    offset = normalizeLoopOffset(loop, loop.playOffset);
  }
  sourceNode.start(startAt, offset);
  if (stopAfter !== null) {
    sourceNode.stop(startAt + stopAfter);
  }

  loop.node = sourceNode;
  loop.gainNode = gainNode;
  loop.pannerNode = pannerNode;
  loop.eqNodes = eqNodes;
  loop.fxChain = fxChain;
  loop.playStartTime = startAt;
  loop.playOffset = offset;
  loop.playing = true;

  // Reset loop state when a scheduled (song-mode) stop fires.
  sourceNode.onended = () => {
    if (loop.node !== sourceNode) return;
    if (loop.playScheduleTimer) {
      clearTimeout(loop.playScheduleTimer);
      loop.playScheduleTimer = null;
    }
    loop.node = null;
    loop.gainNode = null;
    loop.pannerNode = null;
    setLoopPlayingState(loop, false);
    stopLoopPlayheadAnimation(loop);
    refreshAllGains();
    if (!hasActiveLoops()) {
      transportStartTime = null;
      stopPlaybackPositionTimer();
    }
    updatePlaybackPosition();
  };

  // Flip the loop into its "playing" UI state. Song mode can schedule a loop to
  // begin a bar or more in the future, so defer this until the start actually
  // arrives; near-immediate starts flip synchronously.
  const activatePlayingState = () => {
    if (loop.node !== sourceNode) return;
    loop.playScheduleTimer = null;
    setLoopPlayingState(loop, true);
    updateLoopPlayhead(loop, offset);
    startLoopPlayheadAnimation(loop);
    if (!skipRefresh) refreshAllGains();
    startPlaybackPositionTimer();
    updatePlaybackPosition();
  };

  const startDelay = startAt - audioContext.currentTime;
  if (startDelay <= IMMEDIATE_START_THRESHOLD) {
    activatePlayingState();
  } else {
    loop.playScheduleTimer = setTimeout(activatePlayingState, startDelay * 1000);
  }
}

function stopLoop(loop, options = {}) {
  const {
    immediate = false,
    preserveOffset = false,
    preserveRestart = false,
    fadeDuration = FADE_TIME,
    useLinearFade = false,
  } = options;
  if (!preserveRestart) loop.restartToken = (loop.restartToken || 0) + 1;
  if (!hasActiveOrScheduledPlayback(loop)) {
    loop.playOffset = preserveOffset ? loop.playOffset : 0;
    updateLoopPlayhead(loop, loop.playOffset);
    return;
  }
  const node = loop.node;
  const gain = loop.gainNode;
  const nextOffset = preserveOffset ? getLoopPlaybackPosition(loop) : 0;

  if (loop.playScheduleTimer) {
    clearTimeout(loop.playScheduleTimer);
    loop.playScheduleTimer = null;
  }

  if (gain && !immediate) {
    const t = audioContext.currentTime;
    gain.gain.cancelScheduledValues(t);
    if (useLinearFade) {
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + fadeDuration);
    } else {
      gain.gain.setTargetAtTime(0, t, fadeDuration);
    }
  }
  // Give the fade a few time-constants to decay before killing the source.
  const stopAt = immediate
    ? audioContext.currentTime
    : useLinearFade
      ? audioContext.currentTime + fadeDuration + FADE_TIME
      : audioContext.currentTime + fadeDuration * 5;
  try { node && node.stop(stopAt); } catch { /* already stopped */ }

  // Cancel the gate polling animation frame
  if (loop.fxChain && loop.fxChain.gateState && loop.fxChain.gateState.rafId) {
    cancelAnimationFrame(loop.fxChain.gateState.rafId);
  }

  loop.node = null;
  loop.gainNode = null;
  loop.pannerNode = null;
  loop.fxChain = null;
  loop.eqNodes = null;
  loop.playing = false;
  loop.playStartTime = 0;
  loop.playOffset = nextOffset;
  stopLoopPlayheadAnimation(loop);
  updateLoopPlayhead(loop, nextOffset);

  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    card.classList.remove('playing');
    const btn = card.querySelector('.btn-play');
    if (btn) {
      btn.textContent = '▶';
      btn.classList.remove('active');
      btn.title = 'Play loop';
      btn.setAttribute('aria-label', 'Play loop');
    }
  }
  refreshAllGains();
  if (!hasActiveLoops()) {
    transportStartTime = null;
    stopPlaybackPositionTimer();
  }
  updatePlaybackPosition();
}

function refreshLoopPlayback(loop) {
  if (!loop.playing) return;
  stopLoop(loop);
  setTimeout(() => playLoop(loop), getFadeSettleDelayMs());
}

function deleteLoop(loopId) {
  const idx = loops.findIndex(l => l.id === loopId);
  if (idx === -1) return;
  const loop = loops[idx];
  if (midiLearnTarget && midiLearnTarget.target.startsWith(`loop-${loopId}-`)) {
    stopMidiLearn();
  }
  const action = {
    kind: 'delete',
    loops: [{ loop, index: idx }],
  };
  applyDeleteAction(action);
  rememberUndoAction(action);
  refreshSceneButtons();
  refreshAllGains();
  refreshPunchLoopOptions();
  showInfo(`Deleted "${loop.name}" – press ↶ Undo (or Ctrl+Z) to restore.`);
}

function undoDelete() {
  const action = undoStack.pop();
  if (!action) return;
  restoreDeleteAction(action);
  redoStack.push(action);
  if (redoStack.length > MAX_UNDO) redoStack.shift();
  updateHistoryButtons();
  refreshAllGains();
  refreshPunchLoopOptions();
  setStatus(`Restored ${describeAction(action)}.`);
}

function redoDelete() {
  const action = redoStack.pop();
  if (!action) return;
  applyDeleteAction(action);
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateHistoryButtons();
  refreshAllGains();
  refreshPunchLoopOptions();
  setStatus(`Redid deletion of ${describeAction(action)}.`);
}

function clearAllLoops() {
  if (loops.length === 0) return;
  const confirmed = window.confirm(getClearAllConfirmationMessage(loops.length));
  if (!confirmed) return;

  const action = {
    kind: 'clear-all',
    loops: loops.map((loop, index) => ({ loop, index })),
  };
  applyDeleteAction(action);
  rememberUndoAction(action);
  showInfo(`Cleared all ${formatLoopCount(action.loops.length)} – press ↶ Undo (or Ctrl+Z) to restore ${action.loops.length === 1 ? 'it' : 'them'}.`);
}

function rememberUndoAction(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function applyDeleteAction(action) {
  const ids = new Set(action.loops.map(({ loop }) => loop.id));
  for (const loop of loops) {
    if (ids.has(loop.id)) stopLoop(loop);
  }
  for (let i = loops.length - 1; i >= 0; i--) {
    if (ids.has(loops[i].id)) loops.splice(i, 1);
  }
  renderAllLoops();
}

function restoreDeleteAction(action) {
  const entries = [...action.loops].sort((a, b) => a.index - b.index);
  const existingIds = new Set(loops.map(loop => loop.id));
  for (const { loop, index } of entries) {
    resetLoopPlaybackState(loop);
    if (existingIds.has(loop.id)) continue;
    loops.splice(Math.min(index, loops.length), 0, loop);
    existingIds.add(loop.id);
  }
  renderAllLoops();
}

function resetLoopPlaybackState(loop) {
  loop.node = null;
  loop.gainNode = null;
  loop.pannerNode = null;
  loop.fxChain = null;
  loop.eqNodes = null;
  loop.playing = false;
}

function renderAllLoops() {
  loopsList.querySelectorAll('.loop-card').forEach(card => card.remove());
  loops.forEach(renderLoop);
  updateEmptyState();
  updateHistoryButtons();
}

function describeAction(action) {
  if (action.loops.length === 1) return `"${action.loops[0].loop.name}"`;
  return formatLoopCount(action.loops.length);
}

function formatLoopCount(count) {
  return `${count} loop${count === 1 ? '' : 's'}`;
}

function getClearAllConfirmationMessage(count) {
  if (count === 1) return 'Clear the only loop? This will remove it from your current session.';
  return `Clear all ${count} loops? This will remove them from your current session.`;
}

function updateHistoryButtons() {
  btnUndo.disabled = undoStack.length === 0;
  btnRedo.disabled = redoStack.length === 0;
  btnClearAll.disabled = loops.length === 0;
}

function getLoopCard(loop) {
  return document.getElementById(`loop-card-${loop.id}`);
}

function syncLoopFader(card, key, value, text) {
  if (!card) return;
  const fader = card.querySelector(`[data-fader="${key}"]`);
  if (!fader) return;
  const input = fader.querySelector('input');
  const valueEl = fader.querySelector('.fader-value');
  if (input) input.value = String(value);
  if (valueEl) valueEl.textContent = text;
}

function syncLoopCardState(loop) {
  const card = getLoopCard(loop);
  if (!card) return;

  card.classList.toggle('playing', loop.playing);
  card.classList.toggle('muted', loop.muted);
  card.classList.toggle('soloed', loop.soloed);

  const nameInput = card.querySelector('.loop-name');
  if (nameInput && nameInput !== document.activeElement) {
    nameInput.value = loop.name;
  }

  const btnPlay = card.querySelector('.btn-play');
  if (btnPlay) {
    btnPlay.textContent = loop.playing ? '⏹' : '▶';
    btnPlay.classList.toggle('active', loop.playing);
    btnPlay.title = loop.playing ? 'Stop loop' : 'Play loop';
    btnPlay.setAttribute('aria-label', loop.playing ? 'Stop loop' : 'Play loop');
  }

  const btnMute = card.querySelector('.btn-mute');
  if (btnMute) {
    btnMute.textContent = loop.muted ? '🔇' : '🔊';
    btnMute.title = loop.muted ? 'Unmute' : 'Mute';
    btnMute.setAttribute('aria-label', loop.muted ? 'Unmute loop' : 'Mute loop');
    btnMute.classList.toggle('active', loop.muted);
    btnMute.setAttribute('aria-pressed', loop.muted ? 'true' : 'false');
  }

  const btnSolo = card.querySelector('.btn-solo');
  if (btnSolo) {
    btnSolo.classList.toggle('active', loop.soloed);
    btnSolo.setAttribute('aria-pressed', loop.soloed ? 'true' : 'false');
  }

  const btnReverse = card.querySelector('.btn-reverse');
  if (btnReverse) {
    btnReverse.classList.toggle('active', loop.reversed);
    btnReverse.setAttribute('aria-pressed', loop.reversed ? 'true' : 'false');
  }

  syncLoopFader(card, 'volume', loop.volume, `${Math.round(loop.volume * 100)}%`);
  syncLoopFader(card, 'pan', loop.pan, panText(loop.pan));
  syncLoopFader(card, 'speed', loop.playbackRate, `${loop.playbackRate.toFixed(2)}×`);
}

function setLoopMuted(loop, muted) {
  loop.muted = muted;
  syncLoopCardState(loop);
  refreshAllGains();
}

function toggleMute(loop) {
  setLoopMuted(loop, !loop.muted);
}

function setLoopSoloed(loop, soloed) {
  loop.soloed = soloed;
  syncLoopCardState(loop);
  refreshAllGains();
}

function toggleSolo(loop) {
  setLoopSoloed(loop, !loop.soloed);
}

function setLoopVolume(loop, value) {
  loop.volume = value;
  updateLoopVolumeUI(loop);
  refreshAllGains();
}

function setLoopPan(loop, value) {
  loop.pan = value;
  if (loop.pannerNode) {
    loop.pannerNode.pan.setTargetAtTime(value, audioContext.currentTime, PARAM_TRANSITION);
  }
}

function setLoopEq(loop, band, value) {
  loop[band] = value;
  if (!loop.eqNodes) return;

  const filterKey = EQ_FILTER_BY_BAND[band];
  const filterNode = filterKey ? loop.eqNodes[filterKey] : null;

  if (filterNode) {
    filterNode.gain.setTargetAtTime(value, audioContext.currentTime, PARAM_TRANSITION);
  }
  syncLoopCardState(loop);
}

function setLoopPlaybackRate(loop, value) {
  loop.playbackRate = value;
  invalidateLoopProcessing(loop);
  restartLoopPlayback(loop);
  syncLoopPlaybackRateControls(loop);
  updateLoopTempoUi(loop);
}

function toggleFollowTempo(loop, enabled) {
  loop.followTempo = enabled;
  if (enabled) loop.tempoBaseBpm = bpm;
  updateLoopPlaybackRate(loop);
  updateLoopTempoUi(loop);
}

function isPlaybackRate(value, target) {
  return Math.abs(value - target) < PLAYBACK_RATE_EPSILON;
}

function syncLoopPlaybackRateControls(loop) {
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (!card) return;

  const speedFader = card.querySelector('.fader[data-fader="speed"]');
  if (speedFader) {
    const speedInput = speedFader.querySelector('input[type="range"]');
    if (speedInput) {
      speedInput.value = String(loop.playbackRate);
      setRangeValueText(speedInput, formatPlaybackRateValueText(loop.playbackRate));
    }
    const speedValue = speedFader.querySelector('.fader-value');
    if (speedValue) speedValue.textContent = `${loop.playbackRate.toFixed(2)}×`;
  }

  const btnHalfTime = card.querySelector('.btn-half-time');
  if (btnHalfTime) {
    const active = isPlaybackRate(loop.playbackRate, HALF_TIME_PLAYBACK_RATE);
    btnHalfTime.classList.toggle('active', active);
    btnHalfTime.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  const btnDoubleTime = card.querySelector('.btn-double-time');
  if (btnDoubleTime) {
    const active = isPlaybackRate(loop.playbackRate, DOUBLE_TIME_PLAYBACK_RATE);
    btnDoubleTime.classList.toggle('active', active);
    btnDoubleTime.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function toggleLoopPlaybackRate(loop, targetRate) {
  const nextRate = isPlaybackRate(loop.playbackRate, targetRate)
    ? NORMAL_PLAYBACK_RATE
    : targetRate;
  setLoopPlaybackRate(loop, nextRate);
}

function setLoopPitch(loop, value) {
  loop.pitchSemitones = value;
  invalidateLoopProcessing(loop);
  restartLoopPlayback(loop);
}

function setLoopReversed(loop, reversed, restartPlayback = true) {
  if (loop.reversed === reversed) {
    syncLoopCardState(loop);
    return;
  }
  loop.reversed = reversed;
  if (restartPlayback) {
    restartLoopPlayback(loop);
  }
  syncLoopCardState(loop);
}

function toggleReverse(loop) {
  setLoopReversed(loop, !loop.reversed);
}

function requantizeLoop(loop) {
  const wasPlaying = loop.playing;
  loop.audioBuffer = quantizeBuffer(loop.audioBuffer);
  loop.reversedBuffer = null;
  loop.duration = loop.audioBuffer.duration;

  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    const durationEl = card.querySelector('.loop-duration');
    if (durationEl) durationEl.textContent = formatDuration(loop.duration);

    const canvas = card.querySelector('canvas');
    if (canvas) drawWaveform(canvas, loop.audioBuffer);
  }

  if (wasPlaying) {
    stopLoop(loop);
    setTimeout(() => playLoop(loop), LOOP_RESTART_DELAY_MS);
  }

  setStatus(`Re-quantized "${loop.name}".`);
}

function renameLoop(loop, newName) {
  const trimmed = (newName || '').trim();
  loop.name = trimmed || loop.name;
  refreshPunchLoopOptions();
}

// ─── Group management ──────────────────────────────────────────────────────

/** Return the DOM container where loops with the given groupId should live. */
function getLoopContainer(groupId) {
  if (groupId == null) return ungroupedLoops;
  return document.getElementById(`group-loops-${groupId}`);
}

function addGroup() {
  groupCounter++;
  /** @type {Group} */
  const group = {
    id: groupCounter,
    name: `Group ${groupCounter}`,
    volume: 1,
    muted: false,
    soloed: false,
  };
  groups.push(group);
  renderGroup(group);
  updateAllGroupSelectors();
}

function deleteGroup(groupId) {
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx === -1) return;
  groups.splice(idx, 1);

  // Move loops that were in this group to ungrouped
  for (const l of loops) {
    if (l.groupId === groupId) {
      l.groupId = null;
      const card = document.getElementById(`loop-card-${l.id}`);
      if (card) ungroupedLoops.appendChild(card);
    }
  }

  // Remove group DOM element
  const block = document.getElementById(`group-block-${groupId}`);
  if (block) block.remove();

  updateAllGroupSelectors();
  refreshAllGains();
}

function renameGroup(group, newName) {
  const trimmed = (newName || '').trim();
  group.name = trimmed || group.name;
  updateAllGroupSelectors();
}

function toggleGroupMute(group) {
  group.muted = !group.muted;
  const block = document.getElementById(`group-block-${group.id}`);
  if (block) {
    block.classList.toggle('group-muted', group.muted);
    const btn = block.querySelector('.btn-group-mute');
    if (btn) {
      btn.textContent = group.muted ? '🔇' : '🔊';
      btn.title = group.muted ? 'Unmute group' : 'Mute group';
      btn.setAttribute('aria-label', group.muted ? 'Unmute group' : 'Mute group');
      btn.classList.toggle('active', group.muted);
      btn.setAttribute('aria-pressed', group.muted ? 'true' : 'false');
    }
  }
  refreshAllGains();
}

function toggleGroupSolo(group) {
  group.soloed = !group.soloed;
  const block = document.getElementById(`group-block-${group.id}`);
  if (block) {
    block.classList.toggle('group-soloed', group.soloed);
    const btn = block.querySelector('.btn-group-solo');
    if (btn) {
      btn.classList.toggle('active', group.soloed);
      btn.setAttribute('aria-pressed', group.soloed ? 'true' : 'false');
    }
  }
  refreshAllGains();
}

function setGroupVolume(group, value) {
  group.volume = value;
  refreshAllGains();
}

function setLoopGroup(loop, newGroupId) {
  loop.groupId = newGroupId;
  const card = document.getElementById(`loop-card-${loop.id}`);
  const container = getLoopContainer(newGroupId);
  if (card && container) container.appendChild(card);
  // Keep the selector value in sync with the new groupId
  const sel = card && card.querySelector('.loop-group-select');
  if (sel) sel.value = newGroupId != null ? String(newGroupId) : '';
  refreshAllGains();
}

/** Rebuild the <option> list of every loop's group selector to reflect current groups. */
function updateAllGroupSelectors() {
  for (const l of loops) {
    const card = document.getElementById(`loop-card-${l.id}`);
    if (!card) continue;
    const sel = card.querySelector('.loop-group-select');
    if (!sel) continue;
    const current = l.groupId;
    sel.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '—';
    sel.appendChild(noneOpt);
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = String(g.id);
      opt.textContent = g.name;
      sel.appendChild(opt);
    }
    sel.value = current != null ? String(current) : '';
    // If the previously selected group no longer exists, reset to ungrouped
    if (current != null && !groups.find(g => g.id === current)) {
      l.groupId = null;
      sel.value = '';
      const card = document.getElementById(`loop-card-${l.id}`);
      if (card) ungroupedLoops.appendChild(card);
    }
  }
  // Refresh group-name labels on group-name inputs (in case a rename happened)
  for (const g of groups) {
    const block = document.getElementById(`group-block-${g.id}`);
    if (!block) continue;
    const nameInput = block.querySelector('.group-name');
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = g.name;
    }
  }
}

/** Render a group header block and insert it into the loops list before ungrouped loops. */
function renderGroup(group) {
  const block = document.createElement('div');
  block.className = 'group-block';
  block.id = `group-block-${group.id}`;
  if (group.muted)  block.classList.add('group-muted');
  if (group.soloed) block.classList.add('group-soloed');

  // Header row: name, volume fader, mute, solo, delete
  const header = document.createElement('div');
  header.className = 'group-header';

  const nameInput = document.createElement('input');
  nameInput.className = 'group-name';
  nameInput.type = 'text';
  nameInput.value = group.name;
  nameInput.title = 'Rename group';
  nameInput.setAttribute('aria-label', 'Group name');
  nameInput.addEventListener('change', () => {
    renameGroup(group, nameInput.value);
    nameInput.value = group.name;
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });

  const controls = document.createElement('div');
  controls.className = 'group-controls';

  const volFader = makeFader('Vol', 0, 1.5, 0.01, group.volume,
    (v) => `${Math.round(v * 100)}%`,
    (v) => setGroupVolume(group, v));
  volFader.dataset.fader = 'group-volume';

  const btnMute = iconButton('btn-group-mute',
    group.muted ? '🔇' : '🔊',
    group.muted ? 'Unmute group' : 'Mute group',
    () => toggleGroupMute(group));
  btnMute.setAttribute('aria-pressed', group.muted ? 'true' : 'false');
  if (group.muted) btnMute.classList.add('active');

  const btnSolo = iconButton('btn-group-solo', 'S', 'Solo group',
    () => toggleGroupSolo(group));
  btnSolo.setAttribute('aria-pressed', group.soloed ? 'true' : 'false');
  if (group.soloed) btnSolo.classList.add('active');

  const btnDelete = document.createElement('button');
  btnDelete.className = 'btn-danger';
  btnDelete.textContent = '✕';
  btnDelete.title = 'Delete group';
  btnDelete.setAttribute('aria-label', 'Delete group');
  btnDelete.addEventListener('click', () => deleteGroup(group.id));

  controls.append(volFader, btnMute, btnSolo, btnDelete);
  header.append(nameInput, controls);

  // Container for this group's loop cards
  const loopsContainer = document.createElement('div');
  loopsContainer.className = 'group-loops';
  loopsContainer.id = `group-loops-${group.id}`;

  block.append(header, loopsContainer);

  // Insert before the ungrouped-loops container so groups appear above ungrouped loops
  loopsList.insertBefore(block, ungroupedLoops);
}

function onSceneCrossfadeBarsChange() {
  sceneCrossfadeBars = clampSceneCrossfadeBars(parseInt(sceneCrossfadeBarsInput.value, 10));
  sceneCrossfadeBarsInput.value = String(sceneCrossfadeBars);
}

function playAllLoops() {
  if (songModeEnabled) {
    playSongArrangement();
    return;
  }
  if (!audioContext) return;
  if (audioContext.state === 'suspended') audioContext.resume();
  const startAt = audioContext.currentTime + 0.02;
  if (!hasActiveLoops()) {
    transportStartTime = startAt;
  }
  loops.forEach(loop => playLoop(loop, { startAt }));
}

function stopAllLoops() {
  clearTimeout(songEndTimeout);
  songEndTimeout = null;
  loops.forEach(loop => stopLoop(loop));
}

function onMasterVolumeChange(e) {
  masterVolume = parseFloat(e.target.value);
  setRangeValueText(e.target, formatPercentValueText(masterVolume));
  if (masterGainNode) {
    masterGainNode.gain.setTargetAtTime(masterVolume, audioContext.currentTime, 0.01);
  }
}

function onReverbSendChange(e) {
  reverbAmount = parseFloat(e.target.value);
  if (reverbSendGain) {
    reverbSendGain.gain.setTargetAtTime(reverbAmount, audioContext.currentTime, 0.01);
  }
}

function onCompressorToggle(e) {
  compressorEnabled = e.target.checked;
  if (compressorNode && audioContext) {
    if (compressorEnabled) {
      compressorNode.threshold.setTargetAtTime(-24, audioContext.currentTime, 0.01);
      compressorNode.ratio.setTargetAtTime(4, audioContext.currentTime, 0.01);
    } else {
      // Bypass: push threshold to 0 dBFS and ratio to 1:1 (transparent)
      compressorNode.threshold.setTargetAtTime(0, audioContext.currentTime, 0.01);
      compressorNode.ratio.setTargetAtTime(1, audioContext.currentTime, 0.01);
    }
  }
}

function getSceneDefaultName(index) {
  return `Scene ${index + 1}`;
}

function renderSceneSlots() {
  scenesList.innerHTML = '';
  scenes.forEach((scene, index) => {
    const slot = document.createElement('div');
    slot.className = 'scene-slot';
    slot.id = `scene-slot-${index + 1}`;

    const badge = document.createElement('span');
    badge.className = 'scene-index';
    badge.textContent = String(index + 1);

    const nameInput = document.createElement('input');
    nameInput.className = 'scene-name';
    nameInput.type = 'text';
    nameInput.placeholder = getSceneDefaultName(index);
    nameInput.value = scene.name;
    nameInput.setAttribute('aria-label', `Scene ${index + 1} name`);
    nameInput.addEventListener('input', () => {
      scene.name = nameInput.value.trim();
    });

    const saveButton = document.createElement('button');
    saveButton.className = 'btn-secondary scene-save btn-scene-save';
    saveButton.textContent = 'Save';
    saveButton.type = 'button';
    saveButton.addEventListener('click', () => saveScene(index));

    const triggerButton = document.createElement('button');
    triggerButton.className = 'btn-primary scene-trigger btn-scene-trigger';
    triggerButton.textContent = 'Go';
    triggerButton.type = 'button';
    triggerButton.addEventListener('click', () => triggerScene(index));

    slot.append(badge, nameInput, saveButton, triggerButton);
    scenesList.appendChild(slot);
  });
}

function refreshSceneButtons() {
  scenes.forEach((scene, index) => {
    const slot = document.getElementById(`scene-slot-${index + 1}`);
    if (!slot) return;
    slot.classList.toggle('active', scene.snapshot !== null && activeSceneIndex === index);

    const nameInput = slot.querySelector('.scene-name');
    const saveButton = slot.querySelector('.scene-save');
    const triggerButton = slot.querySelector('.scene-trigger');

    if (nameInput && nameInput !== document.activeElement) {
      nameInput.value = scene.name;
    }
    if (saveButton) saveButton.disabled = loops.length === 0;
    if (triggerButton) triggerButton.disabled = scene.snapshot === null;
  });
}

function captureSceneSnapshot() {
  return {
    masterVolume,
    loops: loops.map(loop => ({
      id: loop.id,
      muted: loop.muted,
      soloed: loop.soloed,
      volume: loop.volume,
      pan: loop.pan,
      playbackRate: loop.playbackRate,
      reversed: loop.reversed,
      playing: loop.playing,
    })),
  };
}

function saveScene(index) {
  if (loops.length === 0) {
    showInfo('Record at least one loop before saving a scene.');
    return;
  }
  const scene = scenes[index];
  scene.name = scene.name || getSceneDefaultName(index);
  scene.snapshot = captureSceneSnapshot();
  activeSceneIndex = index;
  refreshSceneButtons();
  setStatus(`Saved ${scene.name}.`);
}

function triggerScene(index) {
  const scene = scenes[index];
  if (!scene || !scene.snapshot) return false;

  const snapshotByLoopId = new Map(scene.snapshot.loops.map(loop => [loop.id, loop]));
  const fadeSeconds = sceneCrossfadeDuration(bpm, beatsPerBar, sceneCrossfadeBars);
  const useCrossfade = fadeSeconds > 0.001;
  const stopOptions = useCrossfade ? { fadeDuration: fadeSeconds, useLinearFade: true } : {};

  // Fade out (or stop) loops that should not keep playing, or that need a
  // restart because their reverse state differs from the snapshot.
  for (const loop of loops) {
    const snapshot = snapshotByLoopId.get(loop.id);
    if (!snapshot || !snapshot.playing || snapshot.reversed !== loop.reversed) {
      stopLoop(loop, stopOptions);
    }
  }

  masterVolume = scene.snapshot.masterVolume;
  masterVolumeInput.value = String(masterVolume);
  if (masterGainNode) {
    masterGainNode.gain.setTargetAtTime(masterVolume, audioContext.currentTime, 0.01);
  }

  // Restore mixer state for every loop before adjusting playback so gain
  // calculations use the snapshot's mute/solo/volume/pan values.
  for (const loop of loops) {
    const snapshot = snapshotByLoopId.get(loop.id);
    if (!snapshot) {
      setLoopMuted(loop, false);
      setLoopSoloed(loop, false);
      continue;
    }
    setLoopMuted(loop, snapshot.muted);
    setLoopSoloed(loop, snapshot.soloed);
    setLoopVolume(loop, snapshot.volume);
    setLoopPan(loop, snapshot.pan);
    setLoopPlaybackRate(loop, snapshot.playbackRate);
    setLoopReversed(loop, snapshot.reversed, false);
    syncLoopCardState(loop);
  }

  // Start (crossfade in) loops that should play; loops that are already
  // playing ramp to their new gain instead of snapping when a fade is set.
  const transitionToken = ++sceneTransitionToken;
  for (const loop of loops) {
    const snapshot = snapshotByLoopId.get(loop.id);
    if (!snapshot || !snapshot.playing) continue;
    if (loop.playing) {
      if (useCrossfade) rampLoopGain(loop, effectiveGain(loop), fadeSeconds);
    } else {
      playLoop(loop, useCrossfade
        ? {
          initialGain: 0,
          targetGain: effectiveGain(loop),
          fadeDuration: fadeSeconds,
          useLinearFade: true,
          skipRefresh: true,
        }
        : {});
    }
  }

  // Normalise every loop's gain once the transition settles. When crossfading,
  // defer this so the ramps are not clobbered; a newer transition cancels it.
  if (useCrossfade) {
    setTimeout(() => {
      if (sceneTransitionToken !== transitionToken) return;
      refreshAllGains();
    }, Math.ceil((fadeSeconds + FADE_TIME) * 1000));
  } else {
    refreshAllGains();
  }

  activeSceneIndex = index;
  refreshSceneButtons();
  setStatus(`Triggered ${scene.name || getSceneDefaultName(index)}.`);
  return true;
}

// ─── MIDI ─────────────────────────────────────────────────────────────────────

async function enableMidi() {
  if (!navigator.requestMIDIAccess) {
    updateMidiStatus('Web MIDI is not available in this browser.');
    btnEnableMidi.disabled = true;
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    attachMidiInputs();
    if (typeof midiAccess.addEventListener === 'function') {
      midiAccess.addEventListener('statechange', attachMidiInputs);
    } else {
      midiAccess.onstatechange = attachMidiInputs;
    }
    btnEnableMidi.textContent = 'MIDI ready';
    btnEnableMidi.disabled = true;
    updateMidiStatus(`Listening to ${midiAccess.inputs.size} MIDI input${midiAccess.inputs.size === 1 ? '' : 's'}.`);
  } catch (err) {
    updateMidiStatus('Could not enable MIDI access.');
    showError('MIDI access denied or unavailable.');
    console.error('requestMIDIAccess error:', err);
  }
}

function attachMidiInputs() {
  if (!midiAccess) return;
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = onMidiMessage;
  }
  if (!midiLearnTarget) {
    updateMidiStatus(`Listening to ${midiAccess.inputs.size} MIDI input${midiAccess.inputs.size === 1 ? '' : 's'}.`);
  }
}

function onMidiControlsClick(e) {
  const learnBtn = e.target.closest('.btn-midi-learn');
  if (learnBtn) {
    const target = learnBtn.dataset.midiTarget;
    if (target) startMidiLearn(target, learnBtn);
    return;
  }
  const clearBtn = e.target.closest('.btn-midi-clear');
  if (clearBtn) {
    const target = clearBtn.dataset.midiTarget;
    if (target) clearMidiBinding(target);
  }
}

function startMidiLearn(target, buttonEl) {
  stopMidiLearn();
  if (!buttonEl.dataset.defaultLabel) buttonEl.dataset.defaultLabel = buttonEl.textContent;
  midiLearnTarget = { target, buttonEl };
  buttonEl.classList.add('learning');
  buttonEl.textContent = 'Listening…';
  updateMidiStatus(isVolumeTarget(target)
    ? 'Move a MIDI fader or knob to bind volume.'
    : 'Press a MIDI pad or button to bind this action.');
}

function stopMidiLearn() {
  if (!midiLearnTarget) return;
  midiLearnTarget.buttonEl.classList.remove('learning');
  midiLearnTarget.buttonEl.textContent = midiLearnTarget.buttonEl.dataset.defaultLabel || 'Learn';
  midiLearnTarget = null;
}

function onMidiMessage(event) {
  const message = parseMidiMessage(event.data);
  if (!message) return;

  if (midiLearnTarget) {
    const binding = createMidiBinding(message, isVolumeTarget(midiLearnTarget.target) ? 'range' : 'button');
    if (!binding) {
      updateMidiStatus('That control type is not supported for this mapping. Try again.');
      return;
    }
    assignMidiBinding(midiLearnTarget.target, binding);
    updateMidiStatus(`${midiTargetLabel(midiLearnTarget.target)} mapped to ${formatMidiBinding(binding)}.`);
    stopMidiLearn();
    return;
  }

  if (matchesMidiBinding(midiBindings.record, message) && isMidiButtonPress(message)) {
    handleRecordButton();
  }
  if (matchesMidiBinding(midiBindings.playAll, message) && isMidiButtonPress(message)) {
    playAllLoops();
  }
  if (matchesMidiBinding(midiBindings.stopAll, message) && isMidiButtonPress(message)) {
    stopAllLoops();
  }

  for (const loop of loops) {
    if (matchesMidiBinding(loop.midiToggleBinding, message) && isMidiButtonPress(message)) {
      loop.playing ? stopLoop(loop) : playLoop(loop);
    }
    if (matchesMidiBinding(loop.midiVolumeBinding, message)) {
      setLoopVolume(loop, scaleMidiValue(message.value, 0, 1.5));
    }
  }
}

function assignMidiBinding(target, binding) {
  if (target === 'record') midiBindings.record = binding;
  else if (target === 'play-all') midiBindings.playAll = binding;
  else if (target === 'stop-all') midiBindings.stopAll = binding;
  else {
    const { loop, type } = getLoopTarget(target);
    if (!loop) return;
    if (type === 'toggle') loop.midiToggleBinding = binding;
    if (type === 'volume') loop.midiVolumeBinding = binding;
  }
  updateAllMidiBindingLabels();
}

function clearMidiBinding(target) {
  if (target === 'record') midiBindings.record = null;
  else if (target === 'play-all') midiBindings.playAll = null;
  else if (target === 'stop-all') midiBindings.stopAll = null;
  else {
    const { loop, type } = getLoopTarget(target);
    if (!loop) return;
    if (type === 'toggle') loop.midiToggleBinding = null;
    if (type === 'volume') loop.midiVolumeBinding = null;
  }
  if (midiLearnTarget && midiLearnTarget.target === target) stopMidiLearn();
  updateAllMidiBindingLabels();
}

function getLoopTarget(target) {
  const match = /^loop-(\d+)-(toggle|volume)$/.exec(target);
  if (!match) return { loop: null, type: null };
  return {
    loop: loops.find((item) => item.id === parseInt(match[1], 10)) || null,
    type: match[2],
  };
}

function isVolumeTarget(target) {
  return target.endsWith('-volume');
}

function midiTargetLabel(target) {
  if (target === 'record') return 'Record toggle';
  if (target === 'play-all') return 'Play all';
  if (target === 'stop-all') return 'Stop all';
  const { loop, type } = getLoopTarget(target);
  if (!loop) return 'Control';
  return type === 'toggle' ? `${loop.name} toggle` : `${loop.name} volume`;
}

function updateAllMidiBindingLabels() {
  updateMidiBindingLabel('[data-midi-action="record"] .midi-binding-value', midiBindings.record);
  updateMidiBindingLabel('[data-midi-action="play-all"] .midi-binding-value', midiBindings.playAll);
  updateMidiBindingLabel('[data-midi-action="stop-all"] .midi-binding-value', midiBindings.stopAll);
  loops.forEach((loop) => {
    updateMidiBindingLabel(`#loop-card-${loop.id} [data-midi-binding="toggle"]`, loop.midiToggleBinding);
    updateMidiBindingLabel(`#loop-card-${loop.id} [data-midi-binding="volume"]`, loop.midiVolumeBinding);
  });
}

function updateMidiBindingLabel(selector, binding) {
  const el = document.querySelector(selector);
  if (el) el.textContent = formatMidiBinding(binding);
}

function updateMidiStatus(msg) {
  midiStatus.textContent = msg;
}

// ─── Metronome ────────────────────────────────────────────────────────────────

function onBpmChange() {
  hideTempoSuggestion();
  applyBpmValue(bpmInput.value);
  syncPunchBarInputs();
}

function setBpm(v) {
  applyBpmValue(String(v));
  syncPunchBarInputs();
}

function onTapTempo() {
  const now = performance.now();
  const lastTap = tapTempoTimes[tapTempoTimes.length - 1];
  if (lastTap && now - lastTap > TAP_TEMPO_TIMEOUT_MS) {
    // Timeout starts a brand-new tap sequence from the current tap.
    tapTempoTimes = [];
  }
  tapTempoTimes.push(now);
  if (tapTempoTimes.length > TAP_TEMPO_MAX_TAPS) {
    tapTempoTimes = tapTempoTimes.slice(-TAP_TEMPO_MAX_TAPS);
  }
  if (tapTempoTimes.length < 2) return;

  let totalInterval = 0;
  for (let i = 1; i < tapTempoTimes.length; i++) {
    totalInterval += tapTempoTimes[i] - tapTempoTimes[i - 1];
  }
  const averageInterval = totalInterval / (tapTempoTimes.length - 1);
  setBpm(Math.round(60000 / averageInterval));
}

function onBeatsPerBarChange() {
  let v = parseInt(beatsPerBarInput.value, 10);
  if (isNaN(v) || v < 1) v = 4;
  if (v > 12) v = 12;
  beatsPerBar = v;
  beatsPerBarInput.value = String(v);
  if (metronomeEnabled) {
    stopMetronome();
    startMetronome();
  }
  syncPunchBarInputs();
  updatePlaybackPosition();
}

function onBeatUnitChange() {
  let v = parseInt(beatUnitInput.value, 10);
  if (![2, 4, 8, 16].includes(v)) v = 4;
  beatUnit = v;
  beatUnitInput.value = String(v);
  if (metronomeEnabled) {
    stopMetronome();
    startMetronome();
  }
  syncPunchBarInputs();
  updatePlaybackPosition();
}

function onLoopLengthBarsChange() {
  const raw = loopLengthBarsInput.value.trim();
  if (raw === '') {
    loopLengthBars = 0;
    return;
  }

  let v = parseInt(raw, 10);
  if (isNaN(v)) v = 0;
  v = Math.max(MIN_LOOP_LENGTH_BARS, Math.min(MAX_LOOP_LENGTH_BARS, v));
  loopLengthBars = v;
  loopLengthBarsInput.value = String(v);
}

function onMetronomeToggle(e) {
  metronomeEnabled = e.target.checked;
  if (metronomeEnabled) startMetronome(); else stopMetronome();
}

function onSongModeToggle(e) {
  songModeEnabled = e.target.checked;
  if (loops.some(loop => hasActiveOrScheduledPlayback(loop))) {
    stopAllLoops();
  }
}

function onSongBarsChange() {
  let v = parseInt(songBarsInput.value, 10);
  if (isNaN(v) || v < 1) v = DEFAULT_SONG_BARS;
  if (v > MAX_SONG_BARS) v = MAX_SONG_BARS;
  songBars = v;
  songBarsInput.value = String(v);
  if (loops.some(loop => hasActiveOrScheduledPlayback(loop))) {
    stopAllLoops();
  }
  loops.forEach((loop) => {
    applySongTimeline(loop, loop.songStartBar, loop.songBarCount);
  });
}

function applySongTimeline(loop, startBar, barCount) {
  const normalized = normalizeSongTimeline(startBar, barCount, songBars);
  loop.songStartBar = normalized.startBar;
  loop.songBarCount = normalized.barCount;
  syncLoopSongInputs(loop);
}

function playSongArrangement() {
  if (!audioContext || loops.length === 0) return;
  stopAllLoops();

  const barSeconds = (60 / bpm) * beatsPerBar;
  const startTime = audioContext.currentTime + SONG_START_DELAY;

  loops.forEach((loop) => {
    applySongTimeline(loop, loop.songStartBar, loop.songBarCount);
    playLoop(loop, {
      when: startTime + ((loop.songStartBar - 1) * barSeconds),
      stopAfter: loop.songBarCount * barSeconds,
    });
  });

  songEndTimeout = setTimeout(() => {
    songEndTimeout = null;
    setStatus('Song arrangement finished.');
  }, Math.ceil((SONG_START_DELAY + (songBars * barSeconds)) * 1000));
  setStatus('Playing song arrangement…');
}

function onMetronomeSubdivisionChange() {
  let v = parseInt(metronomeSubdivisionInput.value, 10);
  if (!VALID_METRONOME_SUBDIVISIONS.includes(v)) v = 1;
  metronomeSubdivision = v;
  metronomeSubdivisionInput.value = String(v);
  if (metronomeEnabled) {
    stopMetronome();
    startMetronome();
  }
}

function startMetronome() {
  if (metronomeInterval || !audioContext) return;
  const subdivisionsPerBar = beatsPerBar * metronomeSubdivision;
  metronomeBeatIdx = 0;
  playClick('downbeat');
  metronomeBeatIdx = 1;
  const intervalMs = getBeatIntervalMs() / metronomeSubdivision;
  metronomeInterval = setInterval(() => {
    const isDownbeat = metronomeBeatIdx % subdivisionsPerBar === 0;
    const isBeat = metronomeBeatIdx % metronomeSubdivision === 0;
    playClick(isDownbeat ? 'downbeat' : (isBeat ? 'beat' : 'subdivision'));
    metronomeBeatIdx++;
  }, intervalMs);
}

function stopMetronome() {
  if (metronomeInterval) {
    clearInterval(metronomeInterval);
    metronomeInterval = null;
  }
}

function getBeatIntervalMs() {
  return getBeatSeconds(bpm, beatUnit) * 1000;
}

function applyBpmValue(value) {
  const prevBpm = bpm;
  let v = parseInt(value, 10);
  if (isNaN(v)) v = DEFAULT_BPM;
  v = Math.max(MIN_BPM, Math.min(MAX_BPM, v));
  bpm = v;
  bpmInput.value = String(v);
  if (prevBpm !== bpm) {
    loops.forEach((loop) => {
      if (!loop.followTempo) return;
      updateLoopPlaybackRate(loop);
      updateLoopTempoUi(loop);
    });
  }
  updatePlaybackPosition();
  if (metronomeEnabled) {
    stopMetronome();
    startMetronome();
  }
}

function acceptDetectedTempo() {
  if (pendingDetectedBpm === null) return;
  const detectedBpm = pendingDetectedBpm;
  applyBpmValue(String(detectedBpm));
  hideTempoSuggestion();
  setStatus(`Session tempo set to ${detectedBpm} BPM from your first loop.`);
}

function dismissDetectedTempo() {
  if (pendingDetectedBpm === null) return;
  const keptBpm = bpm;
  hideTempoSuggestion();
  setStatus(`Keeping the current ${keptBpm} BPM.`);
}

function hideTempoSuggestion() {
  pendingDetectedBpm = null;
  tempoSuggestion.classList.add('hidden');
}

async function loadDrumSampleLibrary() {
  if (drumSampleBytes) return drumSampleBytes;

  const entries = await Promise.all(
    Object.entries(DRUM_SAMPLE_FILES).map(async ([name, url]) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load ${name} sample.`);
      }
      return [name, await response.arrayBuffer()];
    }),
  );

  drumSampleBytes = Object.fromEntries(entries);
  return drumSampleBytes;
}

async function renderDrumLoop(style) {
  const plan = buildDrumLoopPlan({ style, bpm, beatsPerBar });
  const sampleRate = audioContext.sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(plan.barDuration * sampleRate), sampleRate);
  const sampleBytes = await loadDrumSampleLibrary();
  const samples = Object.fromEntries(
    await Promise.all(
      Object.entries(sampleBytes).map(async ([name, bytes]) => (
        [name, await offline.decodeAudioData(bytes.slice(0))]
      )),
    ),
  );

  for (const hit of plan.hits) {
    const source = offline.createBufferSource();
    source.buffer = samples[hit.sample];

    const gain = offline.createGain();
    gain.gain.value = hit.gain;

    source.connect(gain);
    gain.connect(offline.destination);
    source.start(hit.time);
  }

  return {
    audioBuffer: await offline.startRendering(),
    plan,
  };
}

async function generateDrumLoop() {
  if (!audioContext || generatingDrums) return;

  generatingDrums = true;
  btnGenerateDrums.disabled = true;
  setStatus('Generating drum loop…');

  try {
    if (audioContext.state === 'suspended') await audioContext.resume();

    const { audioBuffer, plan } = await renderDrumLoop(drumStyleSelect.value);
    const label = getDrumStyleLabel(plan.style);
    addLoop(audioBuffer, { name: `${label} Drums · ${bpm} BPM` });
    setStatus(`${label} drum loop added.`);
  } catch (err) {
    showError('Could not generate drums: ' + err.message);
    setStatus('Ready. Press ● REC to start recording.');
  } finally {
    generatingDrums = false;
    btnGenerateDrums.disabled = false;
  }
}

function playClick(type) {
  if (!audioContext) return;
  const t = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const isDownbeat = type === 'downbeat';
  const isSubdivision = type === 'subdivision';
  osc.type = isDownbeat ? 'square' : 'sine';
  osc.frequency.value = isDownbeat
    ? METRONOME_DOWNBEAT_FREQ
    : (isSubdivision ? METRONOME_SUBDIVISION_FREQ : METRONOME_BEAT_FREQ);
  const peak = isDownbeat
    ? (METRONOME_VOLUME * METRONOME_DOWNBEAT_VOLUME_MULTIPLIER)
    : (isSubdivision ? (METRONOME_VOLUME * METRONOME_SUBDIVISION_VOLUME_MULTIPLIER) : METRONOME_VOLUME);
  const duration = isDownbeat ? 0.08 : 0.05;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain);
  // Route clicks directly to the destination so the master volume / mixer
  // can't accidentally silence them and so they're never part of the mixdown.
  gain.connect(audioContext.destination);
  osc.start(t);
  osc.stop(t + duration + 0.01);
}

// ─── Export (mixdown to WAV) ─────────────────────────────────────────────────

async function exportMix() {
  if (loops.length === 0) {
    showInfo('Nothing to export – record a loop first.');
    return;
  }
  setStatus('Rendering mix…');

  const sampleRate = audioContext.sampleRate;
  // Render a chunk that's long enough to hear every loop repeat a few times.
  const maxLoopDur = loops.reduce((m, l) => Math.max(m, getPlaybackBuffer(l).duration / (l.followTempo && l.tempoBaseBpm > 0 ? bpm / l.tempoBaseBpm : 1)), 0);
  const duration   = Math.max(4, Math.min(60, Math.ceil(maxLoopDur * 4)));

  const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const offlineMaster = offline.createGain();
  offlineMaster.gain.value = masterVolume;

  // Mirror live master bus: compressor → destination
  const offlineCompressor = offline.createDynamicsCompressor();
  if (compressorNode) {
    offlineCompressor.threshold.value = compressorNode.threshold.value;
    offlineCompressor.knee.value      = compressorNode.knee.value;
    offlineCompressor.ratio.value     = compressorNode.ratio.value;
    offlineCompressor.attack.value    = compressorNode.attack.value;
    offlineCompressor.release.value   = compressorNode.release.value;
  }
  offlineMaster.connect(offlineCompressor);
  offlineCompressor.connect(offline.destination);

  // Mirror reverb send if active
  if (reverbAmount > 0 && convolverNode && convolverNode.buffer) {
    const offlineReverbSend = offline.createGain();
    offlineReverbSend.gain.value = reverbAmount;
    const offlineConvolver = offline.createConvolver();
    offlineConvolver.buffer = convolverNode.buffer;
    const offlineReverbReturn = offline.createGain();
    offlineReverbReturn.gain.value = 1;
    offlineMaster.connect(offlineReverbSend);
    offlineReverbSend.connect(offlineConvolver);
    offlineConvolver.connect(offlineReverbReturn);
    offlineReverbReturn.connect(offlineCompressor);
  }

  for (const l of loops) {
    const g = effectiveGain(l);
    if (g === 0) continue;

    const src = offline.createBufferSource();
    src.buffer = getPlaybackBuffer(l);
    src.loop = true;
    src.playbackRate.value = l.followTempo && l.tempoBaseBpm > 0 ? bpm / l.tempoBaseBpm : 1;

    const eqNodes = createEqNodes(offline, l);
    const gNode = offline.createGain();
    gNode.gain.value = g;

    // Apply effects chain in the offline context
    const offlineFx = buildFxChain(l, offline);

    if (offline.createStereoPanner) {
      const p = offline.createStereoPanner();
      p.pan.value = l.pan;
      src.connect(eqNodes.lowShelf);
      eqNodes.highShelf.connect(p);
      p.connect(offlineFx.input);
    } else {
      src.connect(eqNodes.lowShelf);
      eqNodes.highShelf.connect(offlineFx.input);
    }
    offlineFx.output.connect(gNode);
    gNode.connect(offlineMaster);
    src.start(0);
  }

  try {
    const rendered = await offline.startRendering();
    const wavBlob = audioBufferToWav(rendered);
    const exportBase = `tottilooper-mix-${Date.now()}`;
    downloadBlob(wavBlob, `${exportBase}.wav`);
    if (exportMidiToggle.checked) {
      const midiBlob = clickTrackToMidi({ bpm, beatsPerBar, durationSeconds: duration });
      downloadBlob(midiBlob, `${exportBase}-click.mid`);
    }
    setStatus(exportMidiToggle.checked ? 'Mix + MIDI exported.' : 'Mix exported.');
  } catch (err) {
    showError('Export failed: ' + err.message);
    setStatus('Ready.');
  }
}

async function shareSession() {
  if (loops.length === 0) {
    showInfo('Nothing to share – record a loop first.');
    return;
  }

  try {
    const payload = await buildSharedSessionPayload();
    const shareUrl = new URL(window.location.href);
    shareUrl.hash = `share=${payload}`;

    if (shareUrl.hash.length > MAX_SHARE_FRAGMENT_LENGTH) {
      showError('This session is too large to fit in a shareable URL.');
      return;
    }

    history.replaceState(null, '', shareUrl);

    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(shareUrl.toString());
        copied = true;
      } catch {
        copied = false;
      }
    }

    setStatus('Share link ready.');
    showInfo(copied
      ? 'Share link copied to your clipboard.'
      : 'Share link saved in the URL bar. Copy it from there to share it.');
  } catch (err) {
    showError('Could not create share link: ' + err.message);
  }
}

function exportLoop(loop) {
  const wavBlob = audioBufferToWav(getPlaybackBuffer(loop));
  const safeName = loop.name.replace(/[^a-z0-9_-]+/gi, '_') || `loop-${loop.id}`;
  downloadBlob(wavBlob, `${safeName}.wav`);
}

function getBarDurationSeconds() {
  return (60 / bpm) * beatsPerBar;
}

function getLoopBarCount(loop) {
  return Math.max(1, Math.round(loop.duration / getBarDurationSeconds()));
}

function getFadeSettleDelayMs() {
  return Math.ceil(FADE_TIME * 1000 * FADE_SETTLE_MULTIPLIER);
}

function clampValue(value, min, max) {
  const numericValue = typeof value === 'number' ? value : parseInt(value, 10);
  if (Number.isNaN(numericValue)) return min;
  return Math.max(min, Math.min(max, numericValue));
}

function getPunchBarRange(loop) {
  const totalBars = getLoopBarCount(loop);
  const startBar = clampValue(punchStartBarInput.value, 1, totalBars);
  const endBar = clampValue(punchEndBarInput.value, startBar, totalBars);
  return { totalBars, startBar, endBar };
}

function refreshPunchLoopOptions() {
  const selectedValue = punchLoopSelect.value;
  punchLoopSelect.innerHTML = '';

  for (const loop of loops) {
    const option = document.createElement('option');
    option.value = String(loop.id);
    option.textContent = loop.name;
    punchLoopSelect.appendChild(option);
  }

  if (loops.length > 0) {
    const nextValue = loops.some(loop => String(loop.id) === selectedValue)
      ? selectedValue
      : String(loops[0].id);
    punchLoopSelect.value = nextValue;
  } else {
    punchToggle.checked = false;
  }

  updatePunchControls();
}

function updatePunchControls() {
  const hasLoops = loops.length > 0;
  const enabled = hasLoops && punchToggle.checked;
  punchToggle.disabled = !hasLoops;
  punchLoopSelect.disabled = !enabled;
  punchStartBarInput.disabled = !enabled;
  punchEndBarInput.disabled = !enabled;
  syncPunchBarInputs();
}

function syncPunchBarInputs() {
  const loop = loops.find(item => String(item.id) === punchLoopSelect.value) || loops[0];
  if (!loop) {
    punchBarsTotal.textContent = '/ 1 bar';
    punchStartBarInput.value = '1';
    punchEndBarInput.value = '1';
    return;
  }

  const { totalBars, startBar, endBar } = getPunchBarRange(loop);
  punchStartBarInput.max = String(totalBars);
  punchEndBarInput.max = String(totalBars);
  punchStartBarInput.value = String(startBar);
  punchEndBarInput.value = String(endBar);
  punchBarsTotal.textContent = `/ ${totalBars} ${totalBars === 1 ? 'bar' : 'bars'}`;
}

function getSelectedPunchIn() {
  if (!punchToggle.checked || loops.length === 0) return null;
  const loop = loops.find(item => String(item.id) === punchLoopSelect.value) || loops[0];
  if (!loop) return null;

  const { startBar, endBar } = getPunchBarRange(loop);
  punchStartBarInput.value = String(startBar);
  punchEndBarInput.value = String(endBar);

  return {
    loop,
    startBar,
    endBar,
    durationSeconds: (endBar - startBar + 1) * getBarDurationSeconds(),
  };
}

function clearPunchStopTimer() {
  if (!punchStopTimeout) return;
  clearTimeout(punchStopTimeout);
  punchStopTimeout = null;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function buildSharedSessionPayload() {
  const packed = packSharedSession({
    bpm,
    beatsPerBar,
    masterVolume,
    loops: await Promise.all(loops.map(async (loop) => {
      const shareBlob = getLoopShareBlob(loop);
      return {
        name: loop.name,
        volume: loop.volume,
        pan: loop.pan,
        playbackRate: loop.playbackRate,
        muted: loop.muted,
        soloed: loop.soloed,
        reversed: loop.reversed,
        mimeType: shareBlob.type || 'audio/wav',
        audioBytes: new Uint8Array(await shareBlob.arrayBuffer()),
      };
    })),
  });

  return packed;
}

function getLoopShareBlob(loop) {
  return loop.sourceBlob || audioBufferToWav(loop.audioBuffer);
}

async function restoreSharedSessionFromUrl() {
  const sharePayload = new URLSearchParams(window.location.hash.slice(1)).get('share');
  if (!sharePayload) return;

  try {
    const sharedSession = unpackSharedSession(sharePayload);
    ensureAudioEngine();
    applySharedSessionSettings(sharedSession);

    for (const sharedLoop of sharedSession.loops) {
      const sourceBlob = new Blob([sharedLoop.audioBytes], { type: sharedLoop.mimeType || 'audio/wav' });
      const arrayBuffer = await sourceBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      addLoop(audioBuffer, {
        name: sharedLoop.name,
        volume: sharedLoop.volume,
        pan: sharedLoop.pan,
        playbackRate: sharedLoop.playbackRate,
        muted: sharedLoop.muted,
        soloed: sharedLoop.soloed,
        reversed: sharedLoop.reversed,
        sourceBlob,
      });
    }

    tempoControls.classList.remove('hidden');
    masterControls.classList.remove('hidden');
    loopsSection.classList.remove('hidden');
    updateEmptyState();
    setStatus(`Loaded shared session with ${sharedSession.loops.length} loop${sharedSession.loops.length === 1 ? '' : 's'}.`);
    showInfo('Shared session loaded from the URL.');
  } catch (err) {
    showError('Could not load shared session: ' + err.message);
  }
}

function applySharedSessionSettings(sharedSession) {
  bpm = sharedSession.bpm;
  beatsPerBar = sharedSession.beatsPerBar;
  masterVolume = sharedSession.masterVolume;
  bpmInput.value = String(bpm);
  beatsPerBarInput.value = String(beatsPerBar);
  masterVolumeInput.value = String(masterVolume);
  if (masterGainNode) {
    masterGainNode.gain.value = masterVolume;
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderLoop(loop) {
  const card = document.createElement('div');
  card.className = 'loop-card';
  card.id = `loop-card-${loop.id}`;
  if (loop.muted)  card.classList.add('muted');
  if (loop.soloed) card.classList.add('soloed');
  if (isLeadLoop(loop)) card.classList.add('lead');

  // Top row: name / waveform / duration / action buttons
  const topRow = document.createElement('div');
  topRow.className = 'loop-top';

  const nameInput = document.createElement('input');
  nameInput.className = 'loop-name';
  nameInput.type = 'text';
  nameInput.value = loop.name;
  nameInput.title = 'Rename loop';
  const syncLoopNameLabel = () => {
    nameInput.setAttribute('aria-label', `Loop name for ${loop.name}`);
  };
  syncLoopNameLabel();
  nameInput.addEventListener('change', () => {
    renameLoop(loop, nameInput.value);
    nameInput.value = loop.name;
    syncLoopNameLabel();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });

  const waveformEl = document.createElement('div');
  waveformEl.className = 'loop-waveform';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const startHandle = document.createElement('button');
  startHandle.type = 'button';
  startHandle.className = 'trim-handle trim-start-handle';
  startHandle.title = 'Trim loop start';
  startHandle.setAttribute('aria-label', 'Trim start');
  startHandle.setAttribute('role', 'slider');
  startHandle.setAttribute('aria-valuemin', '0');
  startHandle.setAttribute('aria-valuemax', String(LOOP_EDIT_RESOLUTION));

  const endHandle = document.createElement('button');
  endHandle.type = 'button';
  endHandle.className = 'trim-handle trim-end-handle';
  endHandle.title = 'Trim loop end';
  endHandle.setAttribute('aria-label', 'Trim end');
  endHandle.setAttribute('role', 'slider');
  endHandle.setAttribute('aria-valuemin', '0');
  endHandle.setAttribute('aria-valuemax', String(LOOP_EDIT_RESOLUTION));

  const playhead = document.createElement('div');
  playhead.className = 'loop-playhead';
  playhead.setAttribute('aria-hidden', 'true');
  waveformEl.title = 'Click or drag to scrub';
  waveformEl.append(canvas, startHandle, endHandle, playhead);
  loop.waveformPlayhead = playhead;

  const scrubLoopFromPointer = (event) => {
    const rect = waveformEl.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const offset = ratio * loop.duration;
    if (loop.playing) {
      stopLoop(loop, { immediate: true, preserveOffset: true });
      playLoop(loop, offset);
    } else {
      loop.playOffset = normalizeLoopOffset(loop, offset);
      updateLoopPlayhead(loop, loop.playOffset);
    }
  };

  let isScrubbing = false;
  const onScrubMove = (event) => {
    if (!isScrubbing) return;
    scrubLoopFromPointer(event);
  };
  const endScrub = (event) => {
    if (!isScrubbing) return;
    isScrubbing = false;
    window.removeEventListener('pointermove', onScrubMove);
    window.removeEventListener('pointerup', endScrub);
    window.removeEventListener('pointercancel', endScrub);
    if (waveformEl.hasPointerCapture?.(event.pointerId)) {
      waveformEl.releasePointerCapture(event.pointerId);
    }
  };
  waveformEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target === startHandle || event.target === endHandle) return;
    isScrubbing = true;
    window.addEventListener('pointermove', onScrubMove);
    window.addEventListener('pointerup', endScrub);
    window.addEventListener('pointercancel', endScrub);
    waveformEl.setPointerCapture?.(event.pointerId);
    scrubLoopFromPointer(event);
  });

  const durationEl = document.createElement('span');
  durationEl.className = 'loop-duration';

  const keyEl = document.createElement('span');
  keyEl.className = 'loop-key';
  keyEl.textContent = loop.detectedKey ? loop.detectedKey.name : 'Key unknown';
  keyEl.title = loop.detectedKey
    ? `Detected key: ${loop.detectedKey.name}`
    : 'Detected key unavailable';

  const metaEl = document.createElement('div');
  metaEl.className = 'loop-meta';
  metaEl.append(durationEl, keyEl);

  const actions = document.createElement('div');
  actions.className = 'loop-actions';

  const btnPlay = iconButton(
    'btn-play',
    loop.playing ? '⏹' : '▶',
    loop.playing ? 'Stop loop' : 'Play loop',
    () => { loop.playing ? stopLoop(loop) : playLoop(loop); },
  );
  if (loop.playing) btnPlay.classList.add('active');

  const btnMute = iconButton(
    'btn-mute',
    loop.muted ? '🔇' : '🔊',
    loop.muted ? 'Unmute' : 'Mute',
    () => toggleMute(loop),
  );
  btnMute.setAttribute('aria-pressed', loop.muted ? 'true' : 'false');
  btnMute.setAttribute('aria-label', loop.muted ? 'Unmute loop' : 'Mute loop');
  if (loop.muted) btnMute.classList.add('active');

  const btnSolo = iconButton('btn-solo', 'S', 'Solo', () => toggleSolo(loop));
  btnSolo.setAttribute('aria-pressed', loop.soloed ? 'true' : 'false');
  if (loop.soloed) btnSolo.classList.add('active');

  const btnLead = iconButton('btn-lead', 'L', 'Set as lead', () => toggleLead(loop));
  btnLead.setAttribute('aria-pressed', isLeadLoop(loop) ? 'true' : 'false');
  if (isLeadLoop(loop)) btnLead.classList.add('active');

  const btnQuantize = iconButton(
    'btn-quantize',
    'Q',
    'Snap loop to current BPM grid',
    () => requantizeLoop(loop),
  );

  const btnReverse = iconButton('btn-reverse', '⇄', 'Reverse', () => toggleReverse(loop));
  btnReverse.setAttribute('aria-pressed', loop.reversed ? 'true' : 'false');
  if (loop.reversed) btnReverse.classList.add('active');

  const btnHalfTime = iconButton(
    'btn-half-time',
    '½×',
    'Toggle half-time',
    () => toggleLoopPlaybackRate(loop, HALF_TIME_PLAYBACK_RATE),
  );

  const btnDoubleTime = iconButton(
    'btn-double-time',
    '2×',
    'Toggle double-time',
    () => toggleLoopPlaybackRate(loop, DOUBLE_TIME_PLAYBACK_RATE),
  );

  const btnExport = iconButton('btn-export', '⬇', 'Export as WAV', () => exportLoop(loop));

  const btnDelete = document.createElement('button');
  btnDelete.className = 'btn-danger';
  btnDelete.textContent = '✕';
  btnDelete.title = 'Delete loop';
  btnDelete.setAttribute('aria-label', 'Delete loop');
  btnDelete.addEventListener('click', () => deleteLoop(loop.id));

  actions.append(
    btnPlay,
    btnMute,
    btnSolo,
    btnLead,
    btnQuantize,
    btnReverse,
    btnHalfTime,
    btnDoubleTime,
    btnExport,
    btnDelete,
  );
  topRow.append(nameInput, waveformEl, metaEl, actions);

  // Bottom row: faders
  const faderRow = document.createElement('div');
  faderRow.className = 'loop-faders';

  const volumeFader = makeFader('Vol', 'Loop volume', 0, 1.5, 0.01, loop.volume,
    (v) => `${Math.round(v * 100)}%`,
    formatPercentValueText,
    (v) => setLoopVolume(loop, v));
  volumeFader.dataset.fader = 'volume';

  const fadeInFader = makeFader('Fade In', 'Fade In', 0, loop.audioBuffer.duration, 0.01, loop.fadeIn,
    formatFadeTime,
    formatFadeValueText,
    (v) => {
      loop.fadeIn = v;
      refreshLoopBuffer(loop);
      updateLoopEditor();
    });
  const fadeOutFader = makeFader('Fade Out', 'Fade Out', 0, loop.audioBuffer.duration, 0.01, loop.fadeOut,
    formatFadeTime,
    formatFadeValueText,
    (v) => {
      loop.fadeOut = v;
      refreshLoopBuffer(loop);
      updateLoopEditor();
    });

  faderRow.append(
    volumeFader,
    makeFader('Pan', 'Loop pan', -1,    1,   0.01, loop.pan,
      panText,
      formatPanValueText,
      (v) => setLoopPan(loop, v)),
    makeFader('Low',  'Loop low EQ',  -18, 18, 0.5, loop.lowEq,
      formatEqGain,
      formatEqValueText,
      (v) => setLoopEq(loop, 'lowEq', v)),
    makeFader('Mid',  'Loop mid EQ',  -18, 18, 0.5, loop.midEq,
      formatEqGain,
      formatEqValueText,
      (v) => setLoopEq(loop, 'midEq', v)),
    makeFader('High', 'Loop high EQ', -18, 18, 0.5, loop.highEq,
      formatEqGain,
      formatEqValueText,
      (v) => setLoopEq(loop, 'highEq', v)),
    makeFader('Speed', 'Loop speed', 0.5,  2,   0.01, loop.playbackRate,
      (v) => `${v.toFixed(2)}×`,
      formatPlaybackRateValueText,
      (v) => setLoopPlaybackRate(loop, v)),
    makeFader('Pitch', 'Loop pitch', -12, 12, 1, loop.pitchSemitones,
      (v) => `${v > 0 ? '+' : ''}${Math.round(v)} st`,
      formatPitchValueText,
      (v) => setLoopPitch(loop, v)),
    fadeInFader,
    fadeOutFader,
  );

  // Group selector
  const groupField = document.createElement('label');
  groupField.className = 'loop-group-field';

  const groupLabel = document.createElement('span');
  groupLabel.className = 'fader-label';
  groupLabel.textContent = 'Group';

  const groupSelect = document.createElement('select');
  groupSelect.className = 'loop-group-select';
  groupSelect.setAttribute('aria-label', 'Assign to group');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '—';
  groupSelect.appendChild(noneOpt);
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = g.name;
    groupSelect.appendChild(opt);
  }
  groupSelect.value = loop.groupId != null ? String(loop.groupId) : '';
  groupSelect.addEventListener('change', () => {
    const v = groupSelect.value;
    setLoopGroup(loop, v === '' ? null : parseInt(v, 10));
  });

  groupField.append(groupLabel, groupSelect);
  faderRow.appendChild(groupField);

  const followTempoToggle = document.createElement('label');
  followTempoToggle.className = 'fader loop-follow-tempo follow-tempo-toggle';

  const followTempoLabel = document.createElement('span');
  followTempoLabel.className = 'fader-label';
  followTempoLabel.textContent = 'Follow tempo';

  const followTempoInput = document.createElement('input');
  followTempoInput.type = 'checkbox';
  followTempoInput.checked = loop.followTempo;
  followTempoInput.setAttribute('aria-label', 'Follow tempo');
  followTempoInput.addEventListener('change', () => toggleFollowTempo(loop, followTempoInput.checked));

  const followTempoValue = document.createElement('span');
  followTempoValue.className = 'fader-value loop-tempo-factor';

  followTempoToggle.append(followTempoLabel, followTempoInput, followTempoValue);
  faderRow.appendChild(followTempoToggle);

  const midiRow = document.createElement('div');
  midiRow.className = 'loop-midi';
  midiRow.innerHTML = `
    <span class="loop-midi-title">MIDI</span>
    <span class="midi-binding-value" data-midi-binding="toggle">Unassigned</span>
    <button class="btn-secondary btn-midi-learn" data-midi-target="loop-${loop.id}-toggle">Learn toggle</button>
    <button class="btn-secondary btn-midi-clear" data-midi-target="loop-${loop.id}-toggle">Clear</button>
    <span class="midi-binding-value" data-midi-binding="volume">Unassigned</span>
    <button class="btn-secondary btn-midi-learn" data-midi-target="loop-${loop.id}-volume">Learn volume</button>
    <button class="btn-secondary btn-midi-clear" data-midi-target="loop-${loop.id}-volume">Clear</button>
  `;

  card.appendChild(topRow);
  card.appendChild(faderRow);
  card.appendChild(makeSongTimelineFields(loop));
  card.appendChild(midiRow);

  // FX section (collapsible)
  card.appendChild(renderFxSection(loop));

  // Canvas sizing requires the element be in the DOM to measure offsetWidth.
  // Append to the right container (group or ungrouped).
  const container = getLoopContainer(loop.groupId);
  container.appendChild(card);
  updateLeadButton(card, loop);
  syncLoopSongInputs(loop);

  function updateDuration() {
    durationEl.textContent = formatDuration(loop.duration);
    durationEl.title = `${loop.duration.toFixed(2)} s`;
  }

  function updateTrimHandle(handle, seconds, ratio) {
    handle.style.left = `${ratio * 100}%`;
    handle.setAttribute('aria-valuenow', String(Math.round(ratio * LOOP_EDIT_RESOLUTION)));
    handle.setAttribute('aria-valuetext', `${seconds.toFixed(2)} seconds`);
  }

  function setFaderDisplay(faderEl, value, formatValue, formatValueText) {
    const input = faderEl.querySelector('input[type="range"]');
    if (input) {
      input.value = String(value);
      setRangeValueText(input, formatValueText(value));
    }
    const valueEl = faderEl.querySelector('.fader-value');
    if (valueEl) valueEl.textContent = formatValue(value);
  }

  function updateLoopEditor() {
    clampLoopEdits(loop);
    updateDuration();
    const totalDuration = loop.audioBuffer.duration || 1;
    const startRatio = loop.trimStart / totalDuration;
    const endRatio = loop.trimEnd / totalDuration;
    updateTrimHandle(startHandle, loop.trimStart, startRatio);
    updateTrimHandle(endHandle, loop.trimEnd, endRatio);
    setFaderDisplay(fadeInFader, loop.fadeIn, formatFadeTime, formatFadeValueText);
    setFaderDisplay(fadeOutFader, loop.fadeOut, formatFadeTime, formatFadeValueText);
    drawWaveform(canvas, loop.audioBuffer, loop);
  }

  function updateTrimFromRatio(edge, ratio, commit) {
    const minRatio = 1 / LOOP_EDIT_RESOLUTION;
    if (edge === 'start') {
      const maxRatio = (loop.trimEnd / loop.audioBuffer.duration) - minRatio;
      loop.trimStart = clamp(ratio, 0, Math.max(0, maxRatio)) * loop.audioBuffer.duration;
    } else {
      const minEndRatio = (loop.trimStart / loop.audioBuffer.duration) + minRatio;
      loop.trimEnd = clamp(ratio, Math.min(1, minEndRatio), 1) * loop.audioBuffer.duration;
    }
    clampLoopEdits(loop);
    updateLoopEditor();
    if (commit) refreshLoopBuffer(loop);
  }

  function bindTrimHandle(handle, edge) {
    function stepTrim(direction) {
      const ratio = edge === 'start'
        ? (loop.trimStart / loop.audioBuffer.duration)
        : (loop.trimEnd / loop.audioBuffer.duration);
      updateTrimFromRatio(edge, clamp(ratio + direction / LOOP_EDIT_RESOLUTION, 0, 1), true);
    }

    handle.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          stepTrim(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          stepTrim(1);
          break;
        case 'Home':
          e.preventDefault();
          updateTrimFromRatio(edge, edge === 'start' ? 0 : (loop.trimStart / loop.audioBuffer.duration), true);
          break;
        case 'End':
          e.preventDefault();
          updateTrimFromRatio(edge, edge === 'end' ? 1 : (loop.trimEnd / loop.audioBuffer.duration), true);
          break;
      }
    });

    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.focus();

      const onMove = (moveEvent) => {
        const rect = waveformEl.getBoundingClientRect();
        const ratio = clamp((moveEvent.clientX - rect.left) / rect.width, 0, 1);
        updateTrimFromRatio(edge, ratio, false);
      };
      const onUp = (upEvent) => {
        const rect = waveformEl.getBoundingClientRect();
        const ratio = clamp((upEvent.clientX - rect.left) / rect.width, 0, 1);
        updateTrimFromRatio(edge, ratio, true);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  bindTrimHandle(startHandle, 'start');
  bindTrimHandle(endHandle, 'end');
  syncLoopPlaybackRateControls(loop);
  updateLoopPlayhead(loop, loop.playOffset);
  updateAllMidiBindingLabels();
  updateLoopTempoUi(loop);
  updateLoopEditor();
  syncLoopCardState(loop);
}

function updateLoopCard(loop) {
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (!card) return;
  const durationEl = card.querySelector('.loop-duration');
  if (durationEl) durationEl.textContent = formatDuration(loop.duration);
  const canvas = card.querySelector('canvas');
  if (canvas) drawWaveform(canvas, loop.audioBuffer);
}

/**
 * Build the collapsible FX section element for a loop card.
 * @param {Loop} loop
 * @returns {HTMLElement}
 */
function renderFxSection(loop) {
  const { fx } = loop;

  const wrapper = document.createElement('div');
  wrapper.className = 'loop-fx';

  // ── Toggle button ────────────────────────────────────────────────────────
  const btnToggle = document.createElement('button');
  btnToggle.className = 'fx-toggle-btn';
  btnToggle.setAttribute('aria-expanded', 'false');
  btnToggle.setAttribute('aria-label', 'Toggle effects');
  btnToggle.textContent = 'FX ▾';
  wrapper.appendChild(btnToggle);

  // ── Panel (hidden by default) ─────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.className = 'fx-panel hidden';
  wrapper.appendChild(panel);

  btnToggle.addEventListener('click', () => {
    const expanded = panel.classList.toggle('hidden');
    btnToggle.setAttribute('aria-expanded', String(!expanded));
    btnToggle.textContent = expanded ? 'FX ▾' : 'FX ▴';
  });

  // ── Helper: labeled checkbox toggle ──────────────────────────────────────
  function fxToggle(label, checked, onChange) {
    const lbl = document.createElement('label');
    lbl.className = 'fx-enable';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    lbl.append(cb, document.createTextNode(label));
    return lbl;
  }

  // ── Helper: compact slider ────────────────────────────────────────────────
  function fxSlider(label, min, max, step, value, fmt, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'fx-slider';
    const titleEl = document.createElement('span');
    titleEl.className = 'fx-slider-label';
    titleEl.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    const valueEl = document.createElement('span');
    valueEl.className = 'fx-slider-value';
    valueEl.textContent = fmt(value);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      valueEl.textContent = fmt(v);
      onChange(v);
    });
    wrap.append(titleEl, input, valueEl);
    return wrap;
  }

  // ── Filter ────────────────────────────────────────────────────────────────
  const filterSection = document.createElement('div');
  filterSection.className = 'fx-row';

  const filterTypeSelect = document.createElement('select');
  filterTypeSelect.className = 'fx-select';
  filterTypeSelect.setAttribute('aria-label', 'Filter type');
  [['lowpass', 'LP'], ['highpass', 'HP']].forEach(([val, text]) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = text;
    opt.selected = fx.filterType === val;
    filterTypeSelect.appendChild(opt);
  });
  filterTypeSelect.addEventListener('change', () => setFxFilterType(loop, filterTypeSelect.value));

  filterSection.append(
    fxToggle('Filter', fx.filterEnabled, (v) => setFxFilterEnabled(loop, v)),
    filterTypeSelect,
    fxSlider('Freq', 20, 20000, 1, fx.filterFreq,
      (v) => `${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)}Hz`,
      (v) => setFxFilterFreq(loop, v)),
    fxSlider('Q', 0.1, 18, 0.1, fx.filterQ,
      (v) => v.toFixed(1),
      (v) => setFxFilterQ(loop, v)),
  );

  // ── Distortion ────────────────────────────────────────────────────────────
  const distSection = document.createElement('div');
  distSection.className = 'fx-row';
  distSection.append(
    fxToggle('Dist', fx.distEnabled, (v) => setFxDistEnabled(loop, v)),
    fxSlider('Drive', 0, 400, 1, fx.distAmount,
      (v) => Math.round(v),
      (v) => setFxDistAmount(loop, v)),
  );

  // ── Delay ─────────────────────────────────────────────────────────────────
  const delaySection = document.createElement('div');
  delaySection.className = 'fx-row';
  delaySection.append(
    fxToggle('Delay', fx.delayEnabled, (v) => setFxDelayEnabled(loop, v)),
    fxSlider('Time', 0.01, 2, 0.01, fx.delayTime,
      (v) => `${v.toFixed(2)}s`,
      (v) => setFxDelayTime(loop, v)),
    fxSlider('Fbk', 0, 0.95, 0.01, fx.delayFeedback,
      (v) => `${Math.round(v * 100)}%`,
      (v) => setFxDelayFeedback(loop, v)),
    fxSlider('Mix', 0, 1, 0.01, fx.delayMix,
      (v) => `${Math.round(v * 100)}%`,
      (v) => setFxDelayMix(loop, v)),
  );

  // ── Reverb ────────────────────────────────────────────────────────────────
  const reverbSection = document.createElement('div');
  reverbSection.className = 'fx-row';
  reverbSection.append(
    fxToggle('Reverb', fx.reverbEnabled, (v) => setFxReverbEnabled(loop, v)),
    fxSlider('Mix', 0, 1, 0.01, fx.reverbMix,
      (v) => `${Math.round(v * 100)}%`,
      (v) => setFxReverbMix(loop, v)),
  );

  // ── Noise Gate ────────────────────────────────────────────────────────────
  const gateSection = document.createElement('div');
  gateSection.className = 'fx-row';
  gateSection.append(
    fxToggle('Gate', fx.gateEnabled, (v) => setFxGateEnabled(loop, v)),
    fxSlider('Thresh', -80, 0, 1, fx.gateThreshold,
      (v) => `${v}dB`,
      (v) => setFxGateThreshold(loop, v)),
  );

  panel.append(filterSection, distSection, delaySection, reverbSection, gateSection);
  return wrapper;
}

function iconButton(cls, text, title, onClick) {
  const b = document.createElement('button');
  b.className = 'btn-icon ' + cls;
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function formatEqGain(value) {
  const n = Number(value) || 0;
  const text = Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1);
  return `${n > 0 ? '+' : ''}${text}dB`;
}

function formatEqValueText(v) {
  const db = Number(v) || 0;
  if (Math.abs(db) < 0.05) return 'Flat';
  const abs = Math.abs(db);
  const rounded = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1);
  return `${rounded} decibels ${db > 0 ? 'boost' : 'cut'}`;
}

function makeFader(label, ariaLabel, min, max, step, value, formatValue, formatValueText, onInput) {
  const wrap = document.createElement('label');
  wrap.className = 'fader';
  wrap.dataset.fader = label.toLowerCase();

  const title = document.createElement('span');
  title.className = 'fader-label';
  title.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.min  = String(min);
  input.max  = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', ariaLabel);

  const valueEl = document.createElement('span');
  valueEl.className = 'fader-value';
  const syncFaderValue = (v) => {
    valueEl.textContent = formatValue(v);
    setRangeValueText(input, formatValueText(v));
  };
  syncFaderValue(value);

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    syncFaderValue(v);
    onInput(v);
  });

  wrap.append(title, input, valueEl);
  return wrap;
}

function makeSongTimelineFields(loop) {
  const row = document.createElement('div');
  row.className = 'loop-song-fields';

  const startField = document.createElement('label');
  startField.className = 'loop-song-field';
  const startLabel = document.createElement('span');
  startLabel.textContent = 'Start';
  const startInput = document.createElement('input');
  startInput.className = 'loop-song-start';
  startInput.type = 'number';
  startInput.min = '1';
  startInput.value = String(loop.songStartBar);
  startInput.setAttribute('aria-label', 'Song start bar');
  startInput.addEventListener('change', () => {
    applySongTimeline(loop, parseInt(startInput.value, 10), loop.songBarCount);
  });
  startField.append(startLabel, startInput);

  const barsField = document.createElement('label');
  barsField.className = 'loop-song-field';
  const barsLabel = document.createElement('span');
  barsLabel.textContent = 'Bars';
  const barsInput = document.createElement('input');
  barsInput.className = 'loop-song-bars';
  barsInput.type = 'number';
  barsInput.min = '1';
  barsInput.value = String(loop.songBarCount);
  barsInput.setAttribute('aria-label', 'Song bar count');
  barsInput.addEventListener('change', () => {
    applySongTimeline(loop, loop.songStartBar, parseInt(barsInput.value, 10));
  });
  barsField.append(barsLabel, barsInput);

  row.append(startField, barsField);
  return row;
}

function syncLoopSongInputs(loop) {
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (!card) return;
  const startInput = card.querySelector('.loop-song-start');
  const barsInput = card.querySelector('.loop-song-bars');
  if (startInput) {
    startInput.max = String(songBars);
    startInput.value = String(loop.songStartBar);
  }
  if (barsInput) {
    barsInput.max = String(songBars);
    barsInput.value = String(loop.songBarCount);
  }
}

function formatFadeTime(seconds) {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(2)}s`;
}

function formatFadeValueText(seconds) {
  if (seconds < 1) return `${Math.round(seconds * 1000)} milliseconds`;
  return `${seconds.toFixed(2)} seconds`;
}

function updateLoopVolumeUI(loop) {
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (!card) return;
  const fader = card.querySelector('[data-fader="volume"]');
  if (!fader) return;
  const input = fader.querySelector('input[type="range"]');
  const valueEl = fader.querySelector('.fader-value');
  if (input) input.value = String(loop.volume);
  if (valueEl) valueEl.textContent = `${Math.round(loop.volume * 100)}%`;
}

function drawWaveform(canvas, audioBuffer, loop = null) {
  const data = audioBuffer.getChannelData(0);
  const dpr  = window.devicePixelRatio || 1;
  const w    = canvas.offsetWidth  || 200;
  const h    = canvas.offsetHeight || 34;

  canvas.width  = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const step = Math.max(1, Math.ceil(data.length / w));
  const mid  = h / 2;
  const styles = getComputedStyle(document.documentElement);

  ctx.fillStyle = styles.getPropertyValue('--waveform-bg').trim();
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = styles.getPropertyValue('--waveform-stroke').trim();
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i++) {
      const sample = data[x * step + i] || 0;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    ctx.moveTo(x, mid + min * mid);
    ctx.lineTo(x, mid + max * mid);
  }
  ctx.stroke();

  if (!loop) return;

  const startX = (loop.trimStart / audioBuffer.duration) * w;
  const endX = (loop.trimEnd / audioBuffer.duration) * w;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, startX, h);
  ctx.fillRect(endX, 0, Math.max(0, w - endX), h);

  ctx.strokeStyle = '#f0f0f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(startX, 0);
  ctx.lineTo(startX, h);
  ctx.moveTo(endX, 0);
  ctx.lineTo(endX, h);
  ctx.stroke();

  ctx.strokeStyle = '#4a90e2';
  ctx.beginPath();
  ctx.moveTo(startX, h - 2);
  ctx.lineTo(
    Math.min(endX, startX + (loop.fadeIn / audioBuffer.duration) * w),
    2,
  );
  ctx.moveTo(
    Math.max(startX, endX - (loop.fadeOut / audioBuffer.duration) * w),
    2,
  );
  ctx.lineTo(endX, h - 2);
  ctx.stroke();
}

function refreshWaveforms() {
  for (const loop of loops) {
    const card = document.getElementById(`loop-card-${loop.id}`);
    const canvas = card && card.querySelector('canvas');
    if (canvas) {
      drawWaveform(canvas, loop.audioBuffer, loop);
    }
  }
}

function updateEmptyState() {
  emptyState.style.display = loops.length === 0 ? 'block' : 'none';
}

function setLoopPlayingState(loop, isPlaying) {
  loop.playing = isPlaying;
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (!card) return;
  card.classList.toggle('playing', isPlaying);
  const btn = card.querySelector('.btn-play');
  if (!btn) return;
  btn.textContent = isPlaying ? '⏹' : '▶';
  btn.classList.toggle('active', isPlaying);
  btn.title = isPlaying ? 'Stop loop' : 'Play loop';
  btn.setAttribute('aria-label', isPlaying ? 'Stop loop' : 'Play loop');
}

// ─── Timer ────────────────────────────────────────────────────────────────────

function startTimer() {
  recordTimer.classList.add('active');
  timerInterval = setInterval(() => {
    const elapsed = (Date.now() - recordStartTime) / 1000;
    recordTimer.textContent = formatDuration(elapsed);
  }, 100);
}

function resetTimer() {
  recordTimer.textContent = '0:00';
  recordTimer.classList.remove('active');
}

// ─── Gamepad controls ─────────────────────────────────────────────────────────

function startGamepadPolling() {
  if (typeof navigator.getGamepads !== 'function') return;

  const tick = () => {
    pollGamepads();
    window.requestAnimationFrame(tick);
  };

  tick();
}

function pollGamepads() {
  const pads = navigator.getGamepads() || [];
  const nextStates = new Map();
  const actionButtons = [
    GAMEPAD_RECORD_BUTTON,
    GAMEPAD_PLAY_BUTTON,
    GAMEPAD_STOP_BUTTON,
    GAMEPAD_NEXT_BUTTON,
  ];

  for (const pad of pads) {
    if (!pad) continue;

    for (const buttonIndex of actionButtons) {
      const key = `${pad.index}:${buttonIndex}`;
      const pressed = isGamepadButtonPressed(pad.buttons[buttonIndex]);
      nextStates.set(key, pressed);

      if (pressed && !gamepadButtonStates.get(key)) {
        handleGamepadAction(buttonIndex);
      }
    }
  }

  gamepadButtonStates.clear();
  nextStates.forEach((pressed, key) => gamepadButtonStates.set(key, pressed));
}

function isGamepadButtonPressed(button) {
  return !!(button && (button.pressed || button.value > 0.5));
}

function handleGamepadAction(buttonIndex) {
  if (!audioContext) return;

  switch (buttonIndex) {
    case GAMEPAD_RECORD_BUTTON:
      handleRecordButton();
      break;
    case GAMEPAD_PLAY_BUTTON:
      playAllLoops();
      break;
    case GAMEPAD_STOP_BUTTON:
      stopAllLoops();
      break;
    case GAMEPAD_NEXT_BUTTON:
      toggleNextLoop();
      break;
  }
}

function toggleLoopByIndex(idx) {
  const loop = loops[idx];
  if (!loop) return;
  loop.playing ? stopLoop(loop) : playLoop(loop);
}

function toggleNextLoop() {
  if (loops.length === 0) return;

  const idx = nextLoopCursor % loops.length;
  toggleLoopByIndex(idx);
  nextLoopCursor = (idx + 1) % loops.length;
}

// ─── Keyboard shortcuts ──────────────────────────────────────────────────────

function onGlobalKeydown(e) {
  // Don't intercept keystrokes inside form fields.
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (helpModal && !helpModal.classList.contains('hidden')) {
    if (e.key === 'Escape') { closeHelp(); e.preventDefault(); }
    return;
  }

  const action = findShortcutAction(e);
  if (action === 'openHelp') {
    e.preventDefault();
    openHelp();
    return;
  }

  if (!audioContext) return;

  if (
    (((e.ctrlKey || e.metaKey) && e.shiftKey) && (e.key === 'z' || e.key === 'Z'))
    || ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y'))
  ) {
    e.preventDefault();
    redoDelete();
    return;
  }

  switch (action) {
    case 'toggleRecord':
      e.preventDefault();
      handleRecordButton();
      break;
    case 'playAll':
      e.preventDefault();
      playAllLoops();
      break;
    case 'stopAll':
      e.preventDefault();
      stopAllLoops();
      break;
    case 'undoDelete':
      e.preventDefault();
      undoDelete();
      break;
    default:
      if (action && action.startsWith('toggleLoop')) {
        e.preventDefault();
        const idx = parseInt(action.slice(-1), 10) - 1;
        if (triggerScene(idx)) return;
        toggleLoopByIndex(idx);
      }
  }
}

// ─── Help modal ───────────────────────────────────────────────────────────────

function openHelp()  { helpModal.classList.remove('hidden'); }
function closeHelp() { helpModal.classList.add('hidden'); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Synthesise a simple stereo reverb impulse response using exponentially-decayed white noise.
 *
 * @param {AudioContext|OfflineAudioContext} context
 * @param {number} [durationSeconds=2] - total IR length in seconds
 * @param {number} [decay=2] - higher values = faster tail decay
 * @returns {AudioBuffer}
 */
function createReverbIR(context, durationSeconds = 2, decay = 2) {
  const length = Math.ceil(context.sampleRate * durationSeconds);
  const ir = context.createBuffer(2, length, context.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return ir;
}

function showLoopWorkspace(withRecordingControls) {
  tempoControls.classList.remove('hidden');
  masterControls.classList.remove('hidden');
  loopsSection.classList.remove('hidden');
  if (withRecordingControls) recordControls.classList.remove('hidden');
}

function sampleLabel(sample) {
  switch (sample) {
    case 'kick':
      return 'Kick';
    case 'snare':
      return 'Snare';
    case 'clap':
      return 'Clap';
    default:
      return 'Sample';
  }
}

function findShortcutAction(event) {
  const shortcut = eventToShortcut(event);
  if (!shortcut) return '';

  for (const definition of shortcutDefinitions) {
    if (shortcuts[definition.action] === shortcut) return definition.action;
  }

  return '';
}

function shortcutToKbdHtml(shortcut) {
  if (!shortcut) return '<span class="shortcut-empty">Unassigned</span>';

  return shortcut
    .split('+')
    .map((part) => `<kbd>${part === 'Mod' ? 'Ctrl/⌘' : part}</kbd>`)
    .join('+');
}

function renderShortcutSettings() {
  shortcutList.innerHTML = '';
  shortcutEditor.innerHTML = '';

  for (const definition of shortcutDefinitions) {
    const shortcut = shortcuts[definition.action];

    const listItem = document.createElement('li');
    listItem.innerHTML = `${shortcutToKbdHtml(shortcut)} – ${definition.label.toLowerCase()}`;
    shortcutList.appendChild(listItem);

    const label = document.createElement('label');
    label.className = 'shortcut-field';

    const text = document.createElement('span');
    text.textContent = definition.label;

    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.value = shortcut;
    input.placeholder = 'Unassigned';
    input.dataset.action = definition.action;
    input.setAttribute('aria-label', `${definition.label} shortcut`);
    input.addEventListener('keydown', onShortcutInputKeydown);

    label.append(text, input);
    shortcutEditor.appendChild(label);
  }

  shortcutRecordHint.innerHTML = shortcutToKbdHtml(shortcuts.toggleRecord);
  shortcutUndoHint.innerHTML = shortcutToKbdHtml(shortcuts.undoDelete);
  btnHelp.title = `Help (press ${shortcuts.openHelp || 'unassigned'})`;
  btnUndo.title = `Undo delete (${shortcuts.undoDelete || 'unassigned'})`;
}

function onShortcutInputKeydown(e) {
  if (e.key === 'Tab') return;

  e.preventDefault();
  const action = e.currentTarget.dataset.action;
  if (!action) return;

  if (e.key === 'Backspace' || e.key === 'Delete') {
    shortcuts[action] = '';
    persistShortcuts();
    showInfo(`Cleared shortcut for ${getShortcutLabel(action)}.`);
    return;
  }

  const shortcut = eventToShortcut(e);
  if (!shortcut) {
    showError('Shortcut must include a non-modifier key.');
    return;
  }

  const conflict = shortcutDefinitions.find((definition) => (
    definition.action !== action && shortcuts[definition.action] === shortcut
  ));
  if (conflict) {
    showError(`${shortcut} is already assigned to ${conflict.label.toLowerCase()}.`);
    return;
  }

  shortcuts[action] = shortcut;
  persistShortcuts();
  showInfo(`Saved shortcut for ${getShortcutLabel(action)}.`);
}

function persistShortcuts() {
  saveShortcutMappings(shortcuts);
  renderShortcutSettings();
}

function resetShortcuts() {
  shortcuts = { ...DEFAULT_SHORTCUTS };
  persistShortcuts();
  showInfo('Keyboard shortcuts reset to defaults.');
}

function getShortcutLabel(action) {
  return shortcutDefinitions.find((definition) => definition.action === action)?.label || action;
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function scheduleRecordingAutoStop() {
  clearRecordingAutoStop();
  if (currentRecordingTargetBars < 1) return;

  const durationMs = barsToDurationMs(
    currentRecordingTargetBars,
    currentRecordingBpm,
    currentRecordingBeatsPerBar,
  );
  recordAutoStopTimeout = setTimeout(() => {
    recordAutoStopTimeout = null;
    shouldNormalizeToTargetBars = true;
    stopRecording();
  }, durationMs);
}

function clearRecordingAutoStop() {
  if (recordAutoStopTimeout) {
    clearTimeout(recordAutoStopTimeout);
    recordAutoStopTimeout = null;
  }
}

function resetRecordingTarget() {
  currentRecordingTargetBars = 0;
  currentRecordingBpm = bpm;
  currentRecordingBeatsPerBar = beatsPerBar;
  shouldNormalizeToTargetBars = false;
}

function formatBars(bars) {
  return `${bars} bar${bars === 1 ? '' : 's'}`;
}

let toastTimeout = null;
function showError(msg) { showToast(msg, 'error'); }
function showInfo(msg)  { showToast(msg, 'info'); }
function showWarning(msg) { showToast(msg, 'warning'); }

function showToast(msg, variant) {
  let toast = document.getElementById('error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'error-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove('fade-out');
  toast.classList.toggle('info', variant === 'info');
  toast.classList.toggle('warning', variant === 'warning');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('fade-out');
  }, 4000);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((error) => {
      console.warn('Service worker registration failed.', error);
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
