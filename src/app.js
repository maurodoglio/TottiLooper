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
  makeDistortionCurve,
  makeReverbIR,
} from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FADE_TIME        = 0.015; // seconds – short fades to avoid clicks on start/stop
const METRONOME_VOLUME = 0.3;
const DEFAULT_BPM      = 100;
const MIN_BPM          = 40;
const MAX_BPM          = 240;
const MAX_UNDO         = 20;

// ─── State ────────────────────────────────────────────────────────────────────

let audioContext   = null;
let mediaStream    = null;
let mediaRecorder  = null;
let recordedChunks = [];
let isRecording    = false;
let timerInterval  = null;
let recordStartTime = 0;
let loopCounter    = 0;

let masterGainNode = null;
let masterVolume   = 1;

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
 * @property {LoopFx} fx
 * @property {object|null} fxChain
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

function quantizeBuffer(buffer) {
  return _quantizeBuffer(buffer, { bpm, beatsPerBar, audioContext });
}

// ─── Loop management ──────────────────────────────────────────────────────────

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

  // Build effects chain and wire: source → panner → fxChain → gain → master
  const fxChain = buildFxChain(loop, audioContext);

  if (pannerNode) {
    sourceNode.connect(pannerNode);
    pannerNode.connect(fxChain.input);
  } else {
    sourceNode.connect(fxChain.input);
  }
  fxChain.output.connect(gainNode);
  gainNode.connect(masterGainNode);

  sourceNode.start();

  loop.node = sourceNode;
  loop.gainNode = gainNode;
  loop.pannerNode = pannerNode;
  loop.fxChain = fxChain;
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

  // Cancel the gate polling animation frame
  if (loop.fxChain && loop.fxChain.gateState && loop.fxChain.gateState.rafId) {
    cancelAnimationFrame(loop.fxChain.gateState.rafId);
  }

  loop.node = null;
  loop.gainNode = null;
  loop.pannerNode = null;
  loop.fxChain = null;
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
  loop.fxChain = null;
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

    // Apply effects chain in the offline context
    const offlineFx = buildFxChain(l, offline);

    if (offline.createStereoPanner) {
      const p = offline.createStereoPanner();
      p.pan.value = l.pan;
      src.connect(p);
      p.connect(offlineFx.input);
    } else {
      src.connect(offlineFx.input);
    }
    offlineFx.output.connect(gNode);
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

  // FX section (collapsible)
  card.appendChild(renderFxSection(loop));

  // Canvas sizing requires the element be in the DOM to measure offsetWidth.
  loopsList.appendChild(card);
  drawWaveform(canvas, loop.audioBuffer);
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
