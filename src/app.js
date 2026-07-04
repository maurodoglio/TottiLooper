/**
 * TottiLooper – main application logic.
 *
 * Solo musicians record short riffs and layer them as continuously-looping
 * audio tracks, simulating a full band while busking.
 */

'use strict';

import { formatDuration, panText } from './utils.js';
import { createExporter } from './exporter.js';
import { createMetronome } from './metronome.js';
import { createMixer } from './mixer.js';
import { createRecorder } from './recorder.js';
import { createUI } from './ui.js';

const FADE_TIME = 0.015;
const METRONOME_VOLUME = 0.3;
const DEFAULT_BPM = 100;
const MIN_BPM = 40;
const MAX_BPM = 240;
const MAX_UNDO = 20;

const state = {
  audioContext: null,
  bpm: DEFAULT_BPM,
  beatsPerBar: 4,
  countInEnabled: false,
  inputAnalyser: null,
  isRecording: false,
  loopCounter: 0,
  masterGainNode: null,
  masterVolume: 1,
  mediaRecorder: null,
  mediaStream: null,
  metronomeBeatIdx: 0,
  metronomeEnabled: false,
  metronomeInterval: null,
  quantizeEnabled: false,
  recordedChunks: [],
  recordStartTime: 0,
  timerInterval: null,
};

const loops = [];
const deletedStack = [];

const $ = (id) => document.getElementById(id);

const dom = {
  beatsPerBarInput: $('beats-per-bar-input'),
  bpmInput: $('bpm-input'),
  btnExportMix: $('btn-export-mix'),
  btnHelp: $('btn-help'),
  btnPlayAll: $('btn-play-all'),
  btnRecord: $('btn-record'),
  btnRequestMic: $('btn-request-mic'),
  btnStopAll: $('btn-stop-all'),
  btnStopRecord: $('btn-stop-record'),
  btnUndo: $('btn-undo'),
  countInToggle: $('count-in-toggle'),
  emptyState: $('empty-state'),
  helpCloseButton: $('help-close'),
  helpModal: $('help-modal'),
  inputMeterFill: $('input-meter-fill'),
  loopsList: $('loops-list'),
  loopsSection: $('loops-section'),
  masterControls: $('master-controls'),
  masterVolumeInput: $('master-volume'),
  metronomeToggle: $('metronome-toggle'),
  permissionBanner: $('permission-banner'),
  quantizeToggle: $('quantize-toggle'),
  recordControls: $('record-controls'),
  recordTimer: $('record-timer'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  tempoControls: $('tempo-controls'),
};

const ui = createUI({ dom, formatDuration, panText });
let exporter;
const mixer = createMixer({
  constants: { FADE_TIME, MAX_UNDO },
  deletedStack,
  dom,
  getExportLoop: () => exporter.exportLoop,
  loops,
  state,
  ui,
});
const metronome = createMetronome({
  constants: { DEFAULT_BPM, MAX_BPM, METRONOME_VOLUME, MIN_BPM },
  dom,
  state,
});
const recorder = createRecorder({
  dom,
  metronome,
  mixer,
  resetTimer,
  startTimer,
  state,
  ui,
});
exporter = createExporter({ loops, mixer, state, ui });

function init() {
  dom.recordControls.classList.add('hidden');
  dom.masterControls.classList.add('hidden');
  dom.loopsSection.classList.add('hidden');
  dom.tempoControls.classList.add('hidden');

  dom.btnRequestMic.addEventListener('click', recorder.requestMicrophoneAccess);
  dom.btnRecord.addEventListener('click', recorder.handleRecordButton);
  dom.btnStopRecord.addEventListener('click', recorder.discardRecording);
  dom.btnPlayAll.addEventListener('click', mixer.playAllLoops);
  dom.btnStopAll.addEventListener('click', mixer.stopAllLoops);
  dom.btnExportMix.addEventListener('click', exporter.exportMix);
  dom.btnUndo.addEventListener('click', mixer.undoDelete);

  dom.masterVolumeInput.addEventListener('input', mixer.onMasterVolumeChange);

  dom.bpmInput.addEventListener('change', metronome.onBpmChange);
  dom.beatsPerBarInput.addEventListener('change', metronome.onBeatsPerBarChange);
  dom.metronomeToggle.addEventListener('change', metronome.onMetronomeToggle);
  dom.countInToggle.addEventListener('change', (e) => {
    state.countInEnabled = e.target.checked;
  });
  dom.quantizeToggle.addEventListener('change', (e) => {
    state.quantizeEnabled = e.target.checked;
  });

  dom.btnHelp.addEventListener('click', ui.openHelp);
  dom.helpCloseButton.addEventListener('click', ui.closeHelp);
  dom.helpModal.addEventListener('click', (e) => {
    if (e.target === dom.helpModal) ui.closeHelp();
  });

  document.addEventListener('keydown', onGlobalKeydown);

  mixer.updateUndoButton();
}

function startTimer() {
  dom.recordTimer.classList.add('active');
  state.timerInterval = setInterval(() => {
    const elapsed = (Date.now() - state.recordStartTime) / 1000;
    dom.recordTimer.textContent = formatDuration(elapsed);
  }, 100);
}

function resetTimer() {
  dom.recordTimer.textContent = '0:00';
  dom.recordTimer.classList.remove('active');
}

function onGlobalKeydown(e) {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (dom.helpModal && !dom.helpModal.classList.contains('hidden')) {
    if (e.key === 'Escape') {
      ui.closeHelp();
      e.preventDefault();
    }
    return;
  }

  if (e.key === '?') {
    e.preventDefault();
    ui.openHelp();
    return;
  }

  if (!state.audioContext) return;

  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    mixer.undoDelete();
    return;
  }

  switch (e.key) {
    case ' ':
      e.preventDefault();
      recorder.handleRecordButton();
      break;
    case 'Enter':
      e.preventDefault();
      mixer.playAllLoops();
      break;
    case 'Escape':
      e.preventDefault();
      mixer.stopAllLoops();
      break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const loop = loops[idx];
        if (loop) mixer.toggleLoopPlayback(loop);
      }
  }
}

document.addEventListener('DOMContentLoaded', init);
