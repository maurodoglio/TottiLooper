/**
 * TottiLooper – main application logic.
 *
 * Solo musicians record short riffs and layer them as continuously-looping
 * audio tracks, simulating a full band while busking.
 */

'use strict';

import {
  formatDuration,
  panText,
  parseMidiMessage,
  createMidiBinding,
  matchesMidiBinding,
  isMidiButtonPress,
  scaleMidiValue,
  formatMidiBinding,
  audioBufferToWav,
  clickTrackToMidi,
  getSupportedMimeType,
  packSharedSession,
  effectiveGain as computeEffectiveGain,
  quantizeBuffer as _quantizeBuffer,
  offsetBuffer as _offsetBuffer,
  reverseBuffer as _reverseBuffer,
  unpackSharedSession,
} from './utils.js';
import {
  DEFAULT_SHORTCUTS,
  eventToShortcut,
  loadShortcutMappings,
  saveShortcutMappings,
} from './shortcuts.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FADE_TIME        = 0.015; // seconds – short fades to avoid clicks on start/stop
const LOOP_RESTART_DELAY_MS = Math.ceil(FADE_TIME * 1000 * 6);
const METRONOME_VOLUME = 0.3;
const DEFAULT_BPM      = 100;
const MIN_BPM          = 40;
const MAX_BPM          = 240;
const MAX_UNDO         = 20;
const MAX_SHARE_FRAGMENT_LENGTH = 12000; // Keeps shared URLs comfortably below common browser limits.
const MIN_MONITOR_OFFSET_MS = -250;
const MAX_MONITOR_OFFSET_MS = 250;

// ─── State ────────────────────────────────────────────────────────────────────

let audioContext   = null;
let mediaStream    = null;
let mediaRecorder  = null;
let recordedChunks = [];
let isRecording    = false;
let timerInterval  = null;
let recordStartTime = 0;
let loopCounter    = 0;
let inputSource    = null;

let masterGainNode = null;
let masterVolume   = 1;

let inputAnalyser  = null;
let monitorGainNode  = null;
let monitoringEnabled = false;
let monitorLatencyOffsetMs = 0;

// Tempo / metronome
let bpm              = DEFAULT_BPM;
let beatsPerBar      = 4;
let metronomeEnabled = false;
let countInEnabled   = false;
let quantizeEnabled  = false;
let metronomeInterval = null;
let metronomeBeatIdx  = 0;

let midiAccess = null;
let midiLearnTarget = null;
const midiBindings = {
  record: null,
  playAll: null,
  stopAll: null,
};

// Undo stack for deleted loops
const deletedStack = [];

/**
 * @typedef {Object} Loop
 * @property {number} id
 * @property {string} name
 * @property {AudioBuffer} audioBuffer
 * @property {AudioBuffer|null} reversedBuffer
 * @property {number} duration
 * @property {AudioBufferSourceNode|null} node
 * @property {GainNode|null} gainNode
 * @property {StereoPannerNode|null} pannerNode
 * @property {boolean} playing
 * @property {boolean} muted
 * @property {boolean} soloed
 * @property {number} volume
 * @property {number} pan
 * @property {number} playbackRate
 * @property {boolean} reversed
 * @property {{ source: 'note' | 'cc', channel: number, number: number, mode: 'button' | 'range' } | null} midiToggleBinding
 * @property {{ source: 'note' | 'cc', channel: number, number: number, mode: 'button' | 'range' } | null} midiVolumeBinding
 * @property {Blob|null} sourceBlob
 */

/** @type {Array<Loop>} */
const loops = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const permissionBanner   = $('permission-banner');
const btnRequestMic      = $('btn-request-mic');
const tempoControls      = $('tempo-controls');
const bpmInput           = $('bpm-input');
const beatsPerBarInput   = $('beats-per-bar-input');
const metronomeToggle    = $('metronome-toggle');
const countInToggle      = $('count-in-toggle');
const quantizeToggle     = $('quantize-toggle');
const recordControls     = $('record-controls');
const btnRecord          = $('btn-record');
const btnStopRecord      = $('btn-stop-record');
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
const masterVolumeInput  = $('master-volume');
const midiControls       = $('midi-controls');
const midiStatus         = $('midi-status');
const btnEnableMidi      = $('btn-enable-midi');
const loopsSection       = $('loops-section');
const loopsList          = $('loops-list');
const emptyState         = $('empty-state');
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

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  recordControls.classList.add('hidden');
  masterControls.classList.add('hidden');
  midiControls.classList.add('hidden');
  loopsSection.classList.add('hidden');
  tempoControls.classList.add('hidden');

  btnRequestMic.addEventListener('click', requestMicrophoneAccess);
  btnRecord.addEventListener('click', handleRecordButton);
  btnStopRecord.addEventListener('click', discardRecording);
  btnPlayAll.addEventListener('click', playAllLoops);
  btnStopAll.addEventListener('click', stopAllLoops);
  btnExportMix.addEventListener('click', exportMix);
  btnShareSession.addEventListener('click', shareSession);
  btnUndo.addEventListener('click', undoDelete);
  btnEnableMidi.addEventListener('click', enableMidi);

  masterVolumeInput.addEventListener('input', onMasterVolumeChange);

  bpmInput.addEventListener('change', onBpmChange);
  beatsPerBarInput.addEventListener('change', onBeatsPerBarChange);
  metronomeToggle.addEventListener('change', onMetronomeToggle);
  countInToggle.addEventListener('change', (e) => { countInEnabled = e.target.checked; });
  quantizeToggle.addEventListener('change', (e) => { quantizeEnabled = e.target.checked; });
  monitoringToggle.addEventListener('change', onMonitoringToggle);
  monitorLatencyInput.addEventListener('change', onMonitorLatencyChange);

  btnHelp.addEventListener('click', openHelp);
  helpCloseButton.addEventListener('click', closeHelp);
  helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp(); });
  midiControls.addEventListener('click', onMidiControlsClick);
  loopsList.addEventListener('click', onMidiControlsClick);
  btnResetShortcuts.addEventListener('click', resetShortcuts);

  shortcuts = loadShortcutMappings();
  renderShortcutSettings();
  document.addEventListener('keydown', onGlobalKeydown);

  updateMidiStatus('Connect a controller, then click Learn to map pads, buttons, or faders.');
  updateAllMidiBindingLabels();
  syncMonitoringControls();
  updateUndoButton();
  void restoreSharedSessionFromUrl();
}

// ─── Microphone access ────────────────────────────────────────────────────────

async function requestMicrophoneAccess() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
      video: false,
    });
    ensureAudioEngine();

    // Input analyser for level meter
    inputSource = audioContext.createMediaStreamSource(mediaStream);
    inputAnalyser = audioContext.createAnalyser();
    inputAnalyser.fftSize = 512;
    inputSource.connect(inputAnalyser);

    monitorGainNode = audioContext.createGain();
    monitorGainNode.gain.value = 0;
    inputSource.connect(monitorGainNode);
    monitorGainNode.connect(masterGainNode);
    updateMonitoringState();

    startInputMeter();

    permissionBanner.classList.add('hidden');
    tempoControls.classList.remove('hidden');
    recordControls.classList.remove('hidden');
    masterControls.classList.remove('hidden');
    midiControls.classList.remove('hidden');
    loopsSection.classList.remove('hidden');
    setStatus('Ready. Press ● REC to start recording.');
  } catch (err) {
    showError('Microphone access denied. Please allow microphone access and reload.');
    console.error('getUserMedia error:', err);
  }
}

function ensureAudioEngine() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (!masterGainNode) {
    masterGainNode = audioContext.createGain();
    masterGainNode.gain.value = masterVolume;
    masterGainNode.connect(audioContext.destination);
  }
}

// ─── Input level meter ────────────────────────────────────────────────────────

function startInputMeter() {
  const buf = new Uint8Array(inputAnalyser.fftSize);
  const tick = () => {
    inputAnalyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128);
      if (v > peak) peak = v;
    }
    const pct = Math.min(100, (peak / 128) * 100 * 1.4);
    if (inputMeterFill) inputMeterFill.style.width = pct.toFixed(1) + '%';
    requestAnimationFrame(tick);
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
  if (countInEnabled) {
    await doCountIn();
  }
  startRecording();
}

function doCountIn() {
  return new Promise((resolve) => {
    const intervalMs = 60000 / bpm;
    let beat = 1;
    setStatus(`Count-in… ${beat}`);
    playClick(true);
    const id = setInterval(() => {
      beat++;
      if (beat > beatsPerBar) {
        clearInterval(id);
        resolve();
        return;
      }
      playClick(false);
      setStatus(`Count-in… ${beat}`);
    }, intervalMs);
  });
}

function startRecording() {
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

  isRecording = true;
  recordStartTime = Date.now();

  btnRecord.textContent = '■ STOP';
  btnRecord.classList.add('recording');
  btnStopRecord.disabled = false;
  statusDot.classList.add('recording');
  setStatus('Recording…');
  startTimer();
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  mediaRecorder.stop();
  isRecording = false;
  clearInterval(timerInterval);

  btnRecord.textContent = '● REC';
  btnRecord.classList.remove('recording');
  btnStopRecord.disabled = true;
  statusDot.classList.remove('recording');
  setStatus('Processing loop…');
}

function discardRecording() {
  if (!isRecording || !mediaRecorder) return;
  mediaRecorder.onstop = null;
  try { mediaRecorder.stop(); } catch { /* ignore */ }
  recordedChunks = [];
  isRecording = false;
  clearInterval(timerInterval);

  btnRecord.textContent = '● REC';
  btnRecord.classList.remove('recording');
  btnStopRecord.disabled = true;
  statusDot.classList.remove('recording');
  resetTimer();
  setStatus('Recording discarded. Press ● REC to try again.');
}

async function onRecordingStop() {
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(recordedChunks, { type: mimeType });
  recordedChunks = [];

  try {
    const arrayBuffer = await blob.arrayBuffer();
    let audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    if (monitorLatencyOffsetMs !== 0) {
      // A positive user-facing compensation value should pull the recorded take earlier.
      audioBuffer = _offsetBuffer(audioBuffer, -monitorLatencyOffsetMs / 1000, audioContext);
    }
    if (quantizeEnabled) {
      audioBuffer = quantizeBuffer(audioBuffer);
    }
    addLoop(audioBuffer, {
      sourceBlob: quantizeEnabled ? audioBufferToWav(audioBuffer) : blob,
    });
    setStatus('Loop added! Press ● REC to record another.');
  } catch (err) {
    showError('Could not decode audio: ' + err.message);
    console.error('decodeAudioData error:', err);
    setStatus('Ready. Press ● REC to start recording.');
  }
  resetTimer();
}

// ─── Quantize (snap loop length to whole bars) ───────────────────────────────

function quantizeBuffer(buffer) {
  return _quantizeBuffer(buffer, { bpm, beatsPerBar, audioContext });
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
    reversedBuffer: null,
    duration: audioBuffer.duration,
    node: null,
    gainNode: null,
    pannerNode: null,
    playing: false,
    muted: !!options.muted,
    soloed: !!options.soloed,
    volume: options.volume ?? 1,
    pan: options.pan ?? 0,
    playbackRate: options.playbackRate ?? 1,
    reversed: !!options.reversed,
    sourceBlob: options.sourceBlob || null,
    midiToggleBinding: null,
    midiVolumeBinding: null,
  };
  loops.push(loop);
  renderLoop(loop);
  updateEmptyState();
}

/** Effective gain for a loop accounting for mute/solo/volume. */
function effectiveGain(loop) {
  return computeEffectiveGain(loop, loops);
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

function getPlaybackBuffer(loop) {
  if (!loop.reversed) return loop.audioBuffer;
  if (!loop.reversedBuffer) {
    loop.reversedBuffer = reverseBuffer(loop.audioBuffer);
  }
  return loop.reversedBuffer;
}

function reverseBuffer(buffer) {
  return _reverseBuffer(buffer, audioContext);
}

function playLoop(loop) {
  if (!audioContext || loop.playing) return;
  if (audioContext.state === 'suspended') audioContext.resume();

  const gainNode = audioContext.createGain();
  const targetGain = effectiveGain(loop);
  gainNode.gain.value = 0;
  gainNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, FADE_TIME);

  const pannerNode = audioContext.createStereoPanner
    ? audioContext.createStereoPanner()
    : null;
  if (pannerNode) pannerNode.pan.value = loop.pan;

  const sourceNode = audioContext.createBufferSource();
  sourceNode.buffer = getPlaybackBuffer(loop);
  sourceNode.loop = true;
  sourceNode.playbackRate.value = loop.playbackRate;

  if (pannerNode) {
    sourceNode.connect(pannerNode);
    pannerNode.connect(gainNode);
  } else {
    sourceNode.connect(gainNode);
  }
  gainNode.connect(masterGainNode);

  sourceNode.start();

  loop.node = sourceNode;
  loop.gainNode = gainNode;
  loop.pannerNode = pannerNode;
  loop.playing = true;

  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    card.classList.add('playing');
    const btn = card.querySelector('.btn-play');
    if (btn) {
      btn.textContent = '⏹';
      btn.classList.add('active');
      btn.title = 'Stop loop';
      btn.setAttribute('aria-label', 'Stop loop');
    }
  }
  refreshAllGains();
}

function stopLoop(loop) {
  if (!loop.playing) return;
  const node = loop.node;
  const gain = loop.gainNode;

  if (gain) {
    const t = audioContext.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0, t, FADE_TIME);
  }
  // Give the fade a few time-constants to decay before killing the source.
  const stopAt = audioContext.currentTime + FADE_TIME * 5;
  try { node && node.stop(stopAt); } catch { /* already stopped */ }

  loop.node = null;
  loop.gainNode = null;
  loop.pannerNode = null;
  loop.playing = false;

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
}

function deleteLoop(loopId) {
  const idx = loops.findIndex(l => l.id === loopId);
  if (idx === -1) return;
  const loop = loops[idx];
  if (midiLearnTarget && midiLearnTarget.target.startsWith(`loop-${loopId}-`)) {
    stopMidiLearn();
  }
  stopLoop(loop);
  loops.splice(idx, 1);

  deletedStack.push(loop);
  if (deletedStack.length > MAX_UNDO) deletedStack.shift();

  const card = document.getElementById(`loop-card-${loopId}`);
  if (card) card.remove();

  updateEmptyState();
  updateUndoButton();
  refreshAllGains();
  showInfo(`Deleted "${loop.name}" – press ↶ Undo (or Ctrl+Z) to restore.`);
}

function undoDelete() {
  const loop = deletedStack.pop();
  if (!loop) return;
  loop.node = null;
  loop.gainNode = null;
  loop.pannerNode = null;
  loop.playing = false;
  loops.push(loop);
  renderLoop(loop);
  updateEmptyState();
  updateUndoButton();
  refreshAllGains();
  setStatus(`Restored "${loop.name}".`);
}

function updateUndoButton() {
  btnUndo.disabled = deletedStack.length === 0;
}

function toggleMute(loop) {
  loop.muted = !loop.muted;
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    card.classList.toggle('muted', loop.muted);
    const btn = card.querySelector('.btn-mute');
    if (btn) {
      btn.textContent = loop.muted ? '🔇' : '🔊';
      btn.title = loop.muted ? 'Unmute' : 'Mute';
      btn.setAttribute('aria-label', loop.muted ? 'Unmute loop' : 'Mute loop');
      btn.classList.toggle('active', loop.muted);
      btn.setAttribute('aria-pressed', loop.muted ? 'true' : 'false');
    }
  }
  refreshAllGains();
}

function toggleSolo(loop) {
  loop.soloed = !loop.soloed;
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    card.classList.toggle('soloed', loop.soloed);
    const btn = card.querySelector('.btn-solo');
    if (btn) {
      btn.classList.toggle('active', loop.soloed);
      btn.setAttribute('aria-pressed', loop.soloed ? 'true' : 'false');
    }
  }
  refreshAllGains();
}

function setLoopVolume(loop, value) {
  loop.volume = value;
  updateLoopVolumeUI(loop);
  refreshAllGains();
}

function setLoopPan(loop, value) {
  loop.pan = value;
  if (loop.pannerNode) {
    loop.pannerNode.pan.setTargetAtTime(value, audioContext.currentTime, 0.01);
  }
}

function setLoopPlaybackRate(loop, value) {
  loop.playbackRate = value;
  if (loop.node) {
    loop.node.playbackRate.setTargetAtTime(value, audioContext.currentTime, 0.01);
  }
}

function toggleReverse(loop) {
  loop.reversed = !loop.reversed;
  const wasPlaying = loop.playing;
  if (wasPlaying) {
    stopLoop(loop);
    setTimeout(() => playLoop(loop), LOOP_RESTART_DELAY_MS);
  }
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    const btn = card.querySelector('.btn-reverse');
    if (btn) {
      btn.classList.toggle('active', loop.reversed);
      btn.setAttribute('aria-pressed', loop.reversed ? 'true' : 'false');
    }
  }
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
}

function playAllLoops() {
  loops.forEach(loop => playLoop(loop));
}

function stopAllLoops() {
  loops.forEach(loop => stopLoop(loop));
}

function onMasterVolumeChange(e) {
  masterVolume = parseFloat(e.target.value);
  if (masterGainNode) {
    masterGainNode.gain.setTargetAtTime(masterVolume, audioContext.currentTime, 0.01);
  }
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
  let v = parseInt(bpmInput.value, 10);
  if (isNaN(v)) v = DEFAULT_BPM;
  v = Math.max(MIN_BPM, Math.min(MAX_BPM, v));
  bpm = v;
  bpmInput.value = String(v);
  if (metronomeEnabled) {
    stopMetronome();
    startMetronome();
  }
}

function onBeatsPerBarChange() {
  let v = parseInt(beatsPerBarInput.value, 10);
  if (isNaN(v) || v < 1) v = 4;
  if (v > 12) v = 12;
  beatsPerBar = v;
  beatsPerBarInput.value = String(v);
}

function onMetronomeToggle(e) {
  metronomeEnabled = e.target.checked;
  if (metronomeEnabled) startMetronome(); else stopMetronome();
}

function startMetronome() {
  if (metronomeInterval || !audioContext) return;
  metronomeBeatIdx = 0;
  playClick(true);
  metronomeBeatIdx = 1;
  const intervalMs = 60000 / bpm;
  metronomeInterval = setInterval(() => {
    const isDown = metronomeBeatIdx % beatsPerBar === 0;
    playClick(isDown);
    metronomeBeatIdx++;
  }, intervalMs);
}

function stopMetronome() {
  if (metronomeInterval) {
    clearInterval(metronomeInterval);
    metronomeInterval = null;
  }
}

function playClick(isDownbeat) {
  if (!audioContext) return;
  const t = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = isDownbeat ? 1500 : 1000;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(METRONOME_VOLUME, t + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(gain);
  // Route clicks directly to the destination so the master volume / mixer
  // can't accidentally silence them and so they're never part of the mixdown.
  gain.connect(audioContext.destination);
  osc.start(t);
  osc.stop(t + 0.06);
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
  const maxLoopDur = loops.reduce((m, l) => Math.max(m, l.duration / l.playbackRate), 0);
  const duration   = Math.max(4, Math.min(60, Math.ceil(maxLoopDur * 4)));

  const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const offlineMaster = offline.createGain();
  offlineMaster.gain.value = masterVolume;
  offlineMaster.connect(offline.destination);

  for (const l of loops) {
    const g = effectiveGain(l);
    if (g === 0) continue;

    const src = offline.createBufferSource();
    src.buffer = getPlaybackBuffer(l);
    src.loop = true;
    src.playbackRate.value = l.playbackRate;

    const gNode = offline.createGain();
    gNode.gain.value = g;

    if (offline.createStereoPanner) {
      const p = offline.createStereoPanner();
      p.pan.value = l.pan;
      src.connect(p);
      p.connect(gNode);
    } else {
      src.connect(gNode);
    }
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

  // Top row: name / waveform / duration / action buttons
  const topRow = document.createElement('div');
  topRow.className = 'loop-top';

  const nameInput = document.createElement('input');
  nameInput.className = 'loop-name';
  nameInput.type = 'text';
  nameInput.value = loop.name;
  nameInput.title = 'Rename loop';
  nameInput.setAttribute('aria-label', 'Loop name');
  nameInput.addEventListener('change', () => {
    renameLoop(loop, nameInput.value);
    nameInput.value = loop.name;
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });

  const waveformEl = document.createElement('div');
  waveformEl.className = 'loop-waveform';
  const canvas = document.createElement('canvas');
  waveformEl.appendChild(canvas);

  const durationEl = document.createElement('span');
  durationEl.className = 'loop-duration';
  durationEl.textContent = formatDuration(loop.duration);

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
  if (loop.muted) btnMute.classList.add('active');

  const btnSolo = iconButton('btn-solo', 'S', 'Solo', () => toggleSolo(loop));
  btnSolo.setAttribute('aria-pressed', loop.soloed ? 'true' : 'false');
  if (loop.soloed) btnSolo.classList.add('active');

  const btnQuantize = iconButton(
    'btn-quantize',
    'Q',
    'Snap loop to current BPM grid',
    () => requantizeLoop(loop),
  );

  const btnReverse = iconButton('btn-reverse', '⇄', 'Reverse', () => toggleReverse(loop));
  btnReverse.setAttribute('aria-pressed', loop.reversed ? 'true' : 'false');
  if (loop.reversed) btnReverse.classList.add('active');

  const btnExport = iconButton('btn-export', '⬇', 'Export as WAV', () => exportLoop(loop));

  const btnDelete = document.createElement('button');
  btnDelete.className = 'btn-danger';
  btnDelete.textContent = '✕';
  btnDelete.title = 'Delete loop';
  btnDelete.setAttribute('aria-label', 'Delete loop');
  btnDelete.addEventListener('click', () => deleteLoop(loop.id));

  actions.append(btnPlay, btnMute, btnSolo, btnQuantize, btnReverse, btnExport, btnDelete);
  topRow.append(nameInput, waveformEl, durationEl, actions);

  // Bottom row: faders
  const faderRow = document.createElement('div');
  faderRow.className = 'loop-faders';

  const volumeFader = makeFader('Vol',   0,    1.5, 0.01, loop.volume,
    (v) => `${Math.round(v * 100)}%`,
    (v) => setLoopVolume(loop, v));
  volumeFader.dataset.fader = 'volume';

  faderRow.append(
    volumeFader,
    makeFader('Pan',  -1,    1,   0.01, loop.pan,
      panText,
      (v) => setLoopPan(loop, v)),
    makeFader('Speed', 0.5,  2,   0.01, loop.playbackRate,
      (v) => `${v.toFixed(2)}×`,
      (v) => setLoopPlaybackRate(loop, v)),
  );

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
  card.appendChild(midiRow);

  // Canvas sizing requires the element be in the DOM to measure offsetWidth.
  loopsList.appendChild(card);
  drawWaveform(canvas, loop.audioBuffer);
  updateAllMidiBindingLabels();
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

function makeFader(label, min, max, step, value, formatValue, onInput) {
  const wrap = document.createElement('label');
  wrap.className = 'fader';

  const title = document.createElement('span');
  title.className = 'fader-label';
  title.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.min  = String(min);
  input.max  = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', label);

  const valueEl = document.createElement('span');
  valueEl.className = 'fader-value';
  valueEl.textContent = formatValue(value);

  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    valueEl.textContent = formatValue(v);
    onInput(v);
  });

  wrap.append(title, input, valueEl);
  return wrap;
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

function drawWaveform(canvas, audioBuffer) {
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

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#e84040';
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
}

function updateEmptyState() {
  emptyState.style.display = loops.length === 0 ? 'block' : 'none';
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
        const loop = loops[idx];
        if (loop) { loop.playing ? stopLoop(loop) : playLoop(loop); }
      }
  }
}

// ─── Help modal ───────────────────────────────────────────────────────────────

function openHelp()  { helpModal.classList.remove('hidden'); }
function closeHelp() { helpModal.classList.add('hidden'); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

let toastTimeout = null;
function showError(msg) { showToast(msg, false); }
function showInfo(msg)  { showToast(msg, true); }

function showToast(msg, isInfo) {
  let toast = document.getElementById('error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'error-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove('fade-out');
  toast.classList.toggle('info', !!isInfo);
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('fade-out');
  }, 4000);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
