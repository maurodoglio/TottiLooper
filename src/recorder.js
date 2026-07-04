import {
  getSupportedMimeType,
  quantizeBuffer as quantizeAudioBuffer,
} from './utils.js';

export function createRecorder({
  state,
  dom,
  ui,
  mixer,
  metronome,
  startTimer,
  resetTimer,
}) {
  async function requestMicrophoneAccess() {
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      state.masterGainNode = state.audioContext.createGain();
      state.masterGainNode.gain.value = state.masterVolume;
      state.masterGainNode.connect(state.audioContext.destination);

      const inputSource = state.audioContext.createMediaStreamSource(state.mediaStream);
      state.inputAnalyser = state.audioContext.createAnalyser();
      state.inputAnalyser.fftSize = 512;
      inputSource.connect(state.inputAnalyser);
      startInputMeter();

      dom.permissionBanner.classList.add('hidden');
      dom.tempoControls.classList.remove('hidden');
      dom.recordControls.classList.remove('hidden');
      dom.masterControls.classList.remove('hidden');
      dom.loopsSection.classList.remove('hidden');
      ui.setStatus('Ready. Press ● REC to start recording.');
    } catch (err) {
      ui.showError('Microphone access denied. Please allow microphone access and reload.');
      console.error('getUserMedia error:', err);
    }
  }

  function startInputMeter() {
    const buffer = new Uint8Array(state.inputAnalyser.fftSize);
    const tick = () => {
      state.inputAnalyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (let i = 0; i < buffer.length; i++) {
        const value = Math.abs(buffer[i] - 128);
        if (value > peak) peak = value;
      }
      const pct = Math.min(100, (peak / 128) * 100 * 1.4);
      if (dom.inputMeterFill) dom.inputMeterFill.style.width = pct.toFixed(1) + '%';
      requestAnimationFrame(tick);
    };
    tick();
  }

  function handleRecordButton() {
    if (state.isRecording) {
      stopRecording();
      return;
    }
    beginRecording();
  }

  async function beginRecording() {
    if (!state.mediaStream) return;
    if (state.countInEnabled) {
      await doCountIn();
    }
    startRecording();
  }

  function doCountIn() {
    return new Promise((resolve) => {
      const intervalMs = 60000 / state.bpm;
      let beat = 1;
      ui.setStatus(`Count-in… ${beat}`);
      metronome.playClick(true);
      const id = setInterval(() => {
        beat++;
        if (beat > state.beatsPerBar) {
          clearInterval(id);
          resolve();
          return;
        }
        metronome.playClick(false);
        ui.setStatus(`Count-in… ${beat}`);
      }, intervalMs);
    });
  }

  function startRecording() {
    if (!state.mediaStream) return;

    state.recordedChunks = [];
    const mimeType = getSupportedMimeType();
    try {
      state.mediaRecorder = new MediaRecorder(
        state.mediaStream,
        mimeType ? { mimeType } : undefined,
      );
    } catch (err) {
      ui.showError('Could not start recording: ' + err.message);
      return;
    }

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
    };
    state.mediaRecorder.onstop = onRecordingStop;
    state.mediaRecorder.start(100);

    state.isRecording = true;
    state.recordStartTime = Date.now();

    dom.btnRecord.textContent = '■ STOP';
    dom.btnRecord.classList.add('recording');
    dom.btnStopRecord.disabled = false;
    dom.statusDot.classList.add('recording');
    ui.setStatus('Recording…');
    startTimer();
  }

  function stopRecording() {
    if (!state.isRecording || !state.mediaRecorder) return;
    state.mediaRecorder.stop();
    state.isRecording = false;
    clearInterval(state.timerInterval);

    dom.btnRecord.textContent = '● REC';
    dom.btnRecord.classList.remove('recording');
    dom.btnStopRecord.disabled = true;
    dom.statusDot.classList.remove('recording');
    ui.setStatus('Processing loop…');
  }

  function discardRecording() {
    if (!state.isRecording || !state.mediaRecorder) return;
    state.mediaRecorder.onstop = null;
    try {
      state.mediaRecorder.stop();
    } catch {
      // ignore recorder stop errors while discarding
    }
    state.recordedChunks = [];
    state.isRecording = false;
    clearInterval(state.timerInterval);

    dom.btnRecord.textContent = '● REC';
    dom.btnRecord.classList.remove('recording');
    dom.btnStopRecord.disabled = true;
    dom.statusDot.classList.remove('recording');
    resetTimer();
    ui.setStatus('Recording discarded. Press ● REC to try again.');
  }

  async function onRecordingStop() {
    const mimeType = (state.mediaRecorder && state.mediaRecorder.mimeType) || 'audio/webm';
    const blob = new Blob(state.recordedChunks, { type: mimeType });
    state.recordedChunks = [];

    try {
      const arrayBuffer = await blob.arrayBuffer();
      let audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
      if (state.quantizeEnabled) {
        audioBuffer = quantizeAudioBuffer(audioBuffer, {
          audioContext: state.audioContext,
          beatsPerBar: state.beatsPerBar,
          bpm: state.bpm,
        });
      }
      mixer.addLoop(audioBuffer);
      ui.setStatus('Loop added! Press ● REC to record another.');
    } catch (err) {
      ui.showError('Could not decode audio: ' + err.message);
      console.error('decodeAudioData error:', err);
      ui.setStatus('Ready. Press ● REC to start recording.');
    }
    resetTimer();
  }

  return {
    discardRecording,
    handleRecordButton,
    requestMicrophoneAccess,
  };
}
