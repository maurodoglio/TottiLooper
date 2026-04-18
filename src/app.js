/**
 * TottiLooper – main application logic
 *
 * Allows solo musicians to record short riffs and layer them as
 * continuously-looping audio tracks, simulating a full band while busking.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let audioContext = null;
let mediaStream  = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let timerInterval = null;
let recordStartTime = 0;
let loopCounter = 0;

/** @type {Array<{id: number, audioBuffer: AudioBuffer, duration: number, node: AudioBufferSourceNode|null, gainNode: GainNode|null, playing: boolean, muted: boolean}>} */
const loops = [];

// ─── DOM references ───────────────────────────────────────────────────────────

const permissionBanner   = document.getElementById('permission-banner');
const btnRequestMic      = document.getElementById('btn-request-mic');
const recordControls     = document.getElementById('record-controls');
const btnRecord          = document.getElementById('btn-record');
const btnStopRecord      = document.getElementById('btn-stop-record');
const recordTimer        = document.getElementById('record-timer');
const statusDot          = document.getElementById('status-dot');
const statusText         = document.getElementById('status-text');
const masterControls     = document.getElementById('master-controls');
const btnPlayAll         = document.getElementById('btn-play-all');
const btnStopAll         = document.getElementById('btn-stop-all');
const loopsSection       = document.getElementById('loops-section');
const loopsList          = document.getElementById('loops-list');
const emptyState         = document.getElementById('empty-state');

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  recordControls.classList.add('hidden');
  masterControls.classList.add('hidden');
  loopsSection.classList.add('hidden');

  btnRequestMic.addEventListener('click', requestMicrophoneAccess);
  btnRecord.addEventListener('click', handleRecordButton);
  btnStopRecord.addEventListener('click', stopRecording);
  btnPlayAll.addEventListener('click', playAllLoops);
  btnStopAll.addEventListener('click', stopAllLoops);
}

// ─── Microphone access ────────────────────────────────────────────────────────

async function requestMicrophoneAccess() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new AudioContext();
    permissionBanner.classList.add('hidden');
    recordControls.classList.remove('hidden');
    masterControls.classList.remove('hidden');
    loopsSection.classList.remove('hidden');
    setStatus('Ready. Press ● REC to start recording.');
  } catch (err) {
    showError('Microphone access denied. Please allow microphone access and reload.');
    console.error('getUserMedia error:', err);
  }
}

// ─── Recording ────────────────────────────────────────────────────────────────

function handleRecordButton() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
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
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start(100); // collect data every 100 ms

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

async function onRecordingStop() {
  const mimeType = mediaRecorder.mimeType || 'audio/webm';
  const blob = new Blob(recordedChunks, { type: mimeType });
  recordedChunks = [];

  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    addLoop(audioBuffer);
    setStatus('Loop added! Press ● REC to record another.');
  } catch (err) {
    showError('Could not decode audio: ' + err.message);
    console.error('decodeAudioData error:', err);
    setStatus('Ready. Press ● REC to start recording.');
  }

  resetTimer();
}

function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ─── Loop management ──────────────────────────────────────────────────────────

function addLoop(audioBuffer) {
  loopCounter++;
  const loop = {
    id: loopCounter,
    audioBuffer,
    duration: audioBuffer.duration,
    node: null,
    gainNode: null,
    playing: false,
    muted: false,
  };
  loops.push(loop);
  renderLoop(loop);
  updateEmptyState();
}

function playLoop(loop) {
  if (!audioContext) return;
  if (loop.playing) return;

  // Resume context if suspended (browser autoplay policy)
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  const gainNode = audioContext.createGain();
  gainNode.gain.value = loop.muted ? 0 : 1;
  gainNode.connect(audioContext.destination);

  const sourceNode = audioContext.createBufferSource();
  sourceNode.buffer = loop.audioBuffer;
  sourceNode.loop = true;
  sourceNode.connect(gainNode);
  sourceNode.start();

  loop.node = sourceNode;
  loop.gainNode = gainNode;
  loop.playing = true;

  // Update card UI
  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    card.classList.add('playing');
    const btn = card.querySelector('.btn-play');
    if (btn) { btn.textContent = '⏹'; btn.classList.add('active'); btn.title = 'Stop loop'; }
  }
}

function stopLoop(loop) {
  if (!loop.playing) return;

  try {
    loop.node && loop.node.stop();
  } catch (_) { /* already stopped */ }

  loop.node = null;
  loop.gainNode = null;
  loop.playing = false;

  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    card.classList.remove('playing');
    const btn = card.querySelector('.btn-play');
    if (btn) { btn.textContent = '▶'; btn.classList.remove('active'); btn.title = 'Play loop'; }
  }
}

function deleteLoop(loopId) {
  const idx = loops.findIndex(l => l.id === loopId);
  if (idx === -1) return;
  stopLoop(loops[idx]);
  loops.splice(idx, 1);

  const card = document.getElementById(`loop-card-${loopId}`);
  if (card) card.remove();

  updateEmptyState();
}

function toggleMute(loop) {
  loop.muted = !loop.muted;
  if (loop.gainNode) {
    loop.gainNode.gain.setTargetAtTime(loop.muted ? 0 : 1, audioContext.currentTime, 0.01);
  }

  const card = document.getElementById(`loop-card-${loop.id}`);
  if (card) {
    card.classList.toggle('muted', loop.muted);
    const btn = card.querySelector('.btn-mute');
    if (btn) {
      btn.textContent = loop.muted ? '🔇' : '🔊';
      btn.title = loop.muted ? 'Unmute' : 'Mute';
      btn.classList.toggle('active', loop.muted);
    }
  }
}

function playAllLoops() {
  loops.forEach(loop => playLoop(loop));
}

function stopAllLoops() {
  loops.forEach(loop => stopLoop(loop));
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderLoop(loop) {
  const card = document.createElement('div');
  card.className = 'loop-card';
  card.id = `loop-card-${loop.id}`;

  const numEl = document.createElement('span');
  numEl.className = 'loop-number';
  numEl.textContent = `#${loop.id}`;

  const waveformEl = document.createElement('div');
  waveformEl.className = 'loop-waveform';
  const canvas = document.createElement('canvas');
  waveformEl.appendChild(canvas);
  drawWaveform(canvas, loop.audioBuffer);

  const durationEl = document.createElement('span');
  durationEl.className = 'loop-duration';
  durationEl.textContent = formatDuration(loop.duration);

  const actions = document.createElement('div');
  actions.className = 'loop-actions';

  const btnPlay = document.createElement('button');
  btnPlay.className = 'btn-icon btn-play';
  btnPlay.textContent = '▶';
  btnPlay.title = 'Play loop';
  btnPlay.addEventListener('click', () => {
    if (loop.playing) { stopLoop(loop); } else { playLoop(loop); }
  });

  const btnMute = document.createElement('button');
  btnMute.className = 'btn-icon btn-mute';
  btnMute.textContent = '🔊';
  btnMute.title = 'Mute';
  btnMute.addEventListener('click', () => toggleMute(loop));

  const btnDelete = document.createElement('button');
  btnDelete.className = 'btn-danger';
  btnDelete.textContent = '✕';
  btnDelete.title = 'Delete loop';
  btnDelete.addEventListener('click', () => deleteLoop(loop.id));

  actions.appendChild(btnPlay);
  actions.appendChild(btnMute);
  actions.appendChild(btnDelete);

  card.appendChild(numEl);
  card.appendChild(waveformEl);
  card.appendChild(durationEl);
  card.appendChild(actions);

  loopsList.appendChild(card);
}

function drawWaveform(canvas, audioBuffer) {
  const data = audioBuffer.getChannelData(0);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth || 200;
  const h = canvas.offsetHeight || 36;

  canvas.width  = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const step = Math.ceil(data.length / w);
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setStatus(msg) {
  statusText.textContent = msg;
}

let toastTimeout = null;
function showError(msg) {
  let toast = document.getElementById('error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'error-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove('fade-out');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('fade-out');
  }, 4000);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
