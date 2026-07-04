// @ts-check
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
  audioBufferToWav,
  getSupportedMimeType,
  effectiveGain as computeEffectiveGain,
  quantizeBuffer as _quantizeBuffer,
  reverseBuffer as _reverseBuffer,
} from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FADE_TIME        = 0.015; // seconds – short fades to avoid clicks on start/stop
const METRONOME_VOLUME = 0.3;
const DEFAULT_BPM      = 100;
const MIN_BPM          = 40;
const MAX_BPM          = 240;
const MAX_UNDO         = 20;

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {AudioContext|null} */
let audioContext   = null;
/** @type {MediaStream|null} */
let mediaStream    = null;
/** @type {MediaRecorder|null} */
let mediaRecorder  = null;
let recordedChunks = [];
let isRecording    = false;
let timerInterval  = null;
let recordStartTime = 0;
let loopCounter    = 0;

/** @type {GainNode|null} */
let masterGainNode = null;
let masterVolume   = 1;

/** @type {AnalyserNode|null} */
let inputAnalyser  = null;

// Tempo / metronome
let bpm              = DEFAULT_BPM;
let beatsPerBar      = 4;
let metronomeEnabled = false;
let countInEnabled   = false;
let quantizeEnabled  = false;
let metronomeInterval = null;
let metronomeBeatIdx  = 0;

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
const masterControls     = $('master-controls');
const btnPlayAll         = $('btn-play-all');
const btnStopAll         = $('btn-stop-all');
const btnExportMix       = $('btn-export-mix');
const btnUndo            = $('btn-undo');
const masterVolumeInput  = $('master-volume');
const loopsSection       = $('loops-section');
const loopsList          = $('loops-list');
const emptyState         = $('empty-state');
const btnHelp            = $('btn-help');
const helpModal          = $('help-modal');
const helpCloseButton    = $('help-close');

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  recordControls.classList.add('hidden');
  masterControls.classList.add('hidden');
  loopsSection.classList.add('hidden');
  tempoControls.classList.add('hidden');

  btnRequestMic.addEventListener('click', requestMicrophoneAccess);
  btnRecord.addEventListener('click', handleRecordButton);
  btnStopRecord.addEventListener('click', discardRecording);
  btnPlayAll.addEventListener('click', playAllLoops);
  btnStopAll.addEventListener('click', stopAllLoops);
  btnExportMix.addEventListener('click', exportMix);
  btnUndo.addEventListener('click', undoDelete);

  masterVolumeInput.addEventListener('input', onMasterVolumeChange);

  bpmInput.addEventListener('change', onBpmChange);
  beatsPerBarInput.addEventListener('change', onBeatsPerBarChange);
  metronomeToggle.addEventListener('change', onMetronomeToggle);
  countInToggle.addEventListener('change', (e) => { countInEnabled = e.target.checked; });
  quantizeToggle.addEventListener('change', (e) => { quantizeEnabled = e.target.checked; });

  btnHelp.addEventListener('click', openHelp);
  helpCloseButton.addEventListener('click', closeHelp);
  helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp(); });

  document.addEventListener('keydown', onGlobalKeydown);

  updateUndoButton();
}

// ─── Microphone access ────────────────────────────────────────────────────────

/**
 * Request microphone access, initialise the AudioContext, and wire up the
 * master gain node and input level analyser.
 *
 * @returns {Promise<void>}
 */
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
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    masterGainNode = audioContext.createGain();
    masterGainNode.gain.value = masterVolume;
    masterGainNode.connect(audioContext.destination);

    // Input analyser for level meter
    const inputSource = audioContext.createMediaStreamSource(mediaStream);
    inputAnalyser = audioContext.createAnalyser();
    inputAnalyser.fftSize = 512;
    inputSource.connect(inputAnalyser);
    startInputMeter();

    permissionBanner.classList.add('hidden');
    tempoControls.classList.remove('hidden');
    recordControls.classList.remove('hidden');
    masterControls.classList.remove('hidden');
    loopsSection.classList.remove('hidden');
    setStatus('Ready. Press ● REC to start recording.');
  } catch (err) {
    showError('Microphone access denied. Please allow microphone access and reload.');
    console.error('getUserMedia error:', err);
  }
}

// ─── Input level meter ────────────────────────────────────────────────────────

/**
 * Begin the animation loop that reads from the input AnalyserNode and updates
 * the level-meter fill bar.
 *
 * @returns {void}
 */
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
    if (quantizeEnabled) {
      audioBuffer = quantizeBuffer(audioBuffer);
    }
    addLoop(audioBuffer);
    setStatus('Loop added! Press ● REC to record another.');
  } catch (err) {
    showError('Could not decode audio: ' + err.message);
    console.error('decodeAudioData error:', err);
    setStatus('Ready. Press ● REC to start recording.');
  }
  resetTimer();
}

// ─── Quantize (snap loop length to whole bars) ───────────────────────────────

/**
 * Snap a recorded AudioBuffer to the nearest whole bar length.
 * Delegates to {@link module:utils.quantizeBuffer} with the current BPM and
 * time-signature state.
 *
 * @param {AudioBuffer} buffer
 * @returns {AudioBuffer}
 */
function quantizeBuffer(buffer) {
  return _quantizeBuffer(buffer, { bpm, beatsPerBar, audioContext });
}

// ─── Loop management ──────────────────────────────────────────────────────────

/**
 * Create a Loop object from a decoded AudioBuffer and append it to the loop
 * list.  The new loop is rendered into the UI; playback must be triggered
 * separately by calling {@link playLoop}.
 *
 * @param {AudioBuffer} audioBuffer
 * @returns {void}
 */
function addLoop(audioBuffer) {
  loopCounter++;
  /** @type {Loop} */
  const loop = {
    id: loopCounter,
    name: `Loop ${loopCounter}`,
    audioBuffer,
    reversedBuffer: null,
    duration: audioBuffer.duration,
    node: null,
    gainNode: null,
    pannerNode: null,
    playing: false,
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0,
    playbackRate: 1,
    reversed: false,
  };
  loops.push(loop);
  renderLoop(loop);
  updateEmptyState();
}

/** 
 * Effective gain for a loop accounting for mute/solo/volume.
 *
 * @param {Loop} loop
 * @returns {number}
 */
function effectiveGain(loop) {
  return computeEffectiveGain(loop, loops);
}

/**
 * Re-apply the effective gain for every currently-playing loop by ramping the
 * GainNode parameters.  Handles mute, solo, and per-loop volume in one pass.
 *
 * @returns {void}
 */
function refreshAllGains() {
  if (!audioContext) return;
  const t = audioContext.currentTime;
  for (const l of loops) {
    if (l.gainNode) {
      l.gainNode.gain.setTargetAtTime(effectiveGain(l), t, 0.01);
    }
  }
}

/**
 * Return the AudioBuffer to use for playback, lazily building the reversed
 * copy on first use when the loop is in reverse mode.
 *
 * @param {Loop} loop
 * @returns {AudioBuffer}
 */
function getPlaybackBuffer(loop) {
  if (!loop.reversed) return loop.audioBuffer;
  if (!loop.reversedBuffer) {
    loop.reversedBuffer = reverseBuffer(loop.audioBuffer);
  }
  return loop.reversedBuffer;
}

/**
 * Build a reversed copy of an AudioBuffer using the current AudioContext.
 *
 * @param {AudioBuffer} buffer
 * @returns {AudioBuffer}
 */
function reverseBuffer(buffer) {
  return _reverseBuffer(buffer, audioContext);
}

/**
 * Start looping playback for a loop by creating and connecting an
 * AudioBufferSourceNode → StereoPannerNode → GainNode → masterGainNode chain.
 * The gain fades in over FADE_TIME to avoid clicks.
 *
 * @param {Loop} loop
 * @returns {void}
 */
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

/**
 * Stop looping playback by fading the GainNode to zero and scheduling the
 * AudioBufferSourceNode to stop after the fade completes.
 *
 * @param {Loop} loop
 * @returns {void}
 */
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

/**
 * Stop and permanently remove a loop from the loop list.  The removed loop is
 * pushed onto the undo stack so it can be restored.
 *
 * @param {number} loopId
 * @returns {void}
 */
function deleteLoop(loopId) {
  const idx = loops.findIndex(l => l.id === loopId);
  if (idx === -1) return;
  const loop = loops[idx];
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

/**
 * @param {Loop} loop
 * @returns {void}
 */
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

/**
 * @param {Loop} loop
 * @returns {void}
 */
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

/**
 * @param {Loop} loop
 * @param {number} value  gain value (0–1.5)
 * @returns {void}
 */
function setLoopVolume(loop, value) {
  loop.volume = value;
  refreshAllGains();
}

/**
 * Update pan on the live StereoPannerNode immediately (ramp) so there is no
 * audible click when the slider moves.
 *
 * @param {Loop} loop
 * @param {number} value  pan value (-1 = full left … 0 = centre … 1 = full right)
 * @returns {void}
 */
function setLoopPan(loop, value) {
  loop.pan = value;
  if (loop.pannerNode) {
    loop.pannerNode.pan.setTargetAtTime(value, audioContext.currentTime, 0.01);
  }
}

/**
 * Update the playback rate on the live AudioBufferSourceNode immediately.
 *
 * @param {Loop} loop
 * @param {number} value  playback rate multiplier (e.g. 0.5 = half speed, 2 = double)
 * @returns {void}
 */
function setLoopPlaybackRate(loop, value) {
  loop.playbackRate = value;
  if (loop.node) {
    loop.node.playbackRate.setTargetAtTime(value, audioContext.currentTime, 0.01);
  }
}

/**
 * Toggle between forward and reversed playback.  If the loop is currently
 * playing it is briefly stopped and restarted so the reversed buffer takes
 * effect immediately.
 *
 * @param {Loop} loop
 * @returns {void}
 */
function toggleReverse(loop) {
  loop.reversed = !loop.reversed;
  const wasPlaying = loop.playing;
  if (wasPlaying) {
    stopLoop(loop);
    setTimeout(() => playLoop(loop), Math.ceil(FADE_TIME * 1000 * 6));
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

/**
 * @param {Loop} loop
 * @param {string} newName
 * @returns {void}
 */
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

/**
 * Synthesise and play a single metronome click using an OscillatorNode routed
 * directly to the AudioContext destination (bypassing the master gain so it is
 * never included in a mixdown).
 *
 * @param {boolean} isDownbeat  true for the accented downbeat click
 * @returns {void}
 */
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

/**
 * Render all loops into a stereo WAV file using an OfflineAudioContext,
 * replicating the live AudioNode graph (source → panner → gain → master).
 *
 * @returns {Promise<void>}
 */
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
    downloadBlob(wavBlob, `tottilooper-mix-${Date.now()}.wav`);
    setStatus('Mix exported.');
  } catch (err) {
    showError('Export failed: ' + err.message);
    setStatus('Ready.');
  }
}

/**
 * Export the playback buffer of a single loop as a WAV file download.
 *
 * @param {Loop} loop
 * @returns {void}
 */
function exportLoop(loop) {
  const wavBlob = audioBufferToWav(getPlaybackBuffer(loop));
  const safeName = loop.name.replace(/[^a-z0-9_-]+/gi, '_') || `loop-${loop.id}`;
  downloadBlob(wavBlob, `${safeName}.wav`);
}

/**
 * Trigger a browser file download for a Blob.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @returns {void}
 */
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

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Build the DOM card for a loop and append it to the loops list.
 *
 * @param {Loop} loop
 * @returns {void}
 */
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

  actions.append(btnPlay, btnMute, btnSolo, btnReverse, btnExport, btnDelete);
  topRow.append(nameInput, waveformEl, durationEl, actions);

  // Bottom row: faders
  const faderRow = document.createElement('div');
  faderRow.className = 'loop-faders';

  faderRow.append(
    makeFader('Vol',   0,    1.5, 0.01, loop.volume,
      (v) => `${Math.round(v * 100)}%`,
      (v) => setLoopVolume(loop, v)),
    makeFader('Pan',  -1,    1,   0.01, loop.pan,
      panText,
      (v) => setLoopPan(loop, v)),
    makeFader('Speed', 0.5,  2,   0.01, loop.playbackRate,
      (v) => `${v.toFixed(2)}×`,
      (v) => setLoopPlaybackRate(loop, v)),
  );

  card.appendChild(topRow);
  card.appendChild(faderRow);

  // Canvas sizing requires the element be in the DOM to measure offsetWidth.
  loopsList.appendChild(card);
  drawWaveform(canvas, loop.audioBuffer);
}

/**
 * @param {string} cls
 * @param {string} text
 * @param {string} title
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function iconButton(cls, text, title, onClick) {
  const b = document.createElement('button');
  b.className = 'btn-icon ' + cls;
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * @param {string} label
 * @param {number} min
 * @param {number} max
 * @param {number} step
 * @param {number} value
 * @param {(v: number) => string} formatValue
 * @param {(v: number) => void} onInput
 * @returns {HTMLLabelElement}
 */
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

/**
 * Render a waveform visualisation onto a canvas element by reading channel 0
 * of the AudioBuffer's sample data.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {AudioBuffer} audioBuffer
 * @returns {void}
 */
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

  if (e.key === '?') {
    e.preventDefault();
    openHelp();
    return;
  }

  if (!audioContext) return;

  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    undoDelete();
    return;
  }

  switch (e.key) {
    case ' ':
      e.preventDefault();
      handleRecordButton();
      break;
    case 'Enter':
      e.preventDefault();
      playAllLoops();
      break;
    case 'Escape':
      e.preventDefault();
      stopAllLoops();
      break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const loop = loops[idx];
        if (loop) { loop.playing ? stopLoop(loop) : playLoop(loop); }
      }
  }
}

// ─── Help modal ───────────────────────────────────────────────────────────────

function openHelp()  { helpModal.classList.remove('hidden'); }
function closeHelp() { helpModal.classList.add('hidden'); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
