export function createMetronome({ state, dom, constants }) {
  function onBpmChange() {
    let nextValue = parseInt(dom.bpmInput.value, 10);
    if (isNaN(nextValue)) nextValue = constants.DEFAULT_BPM;
    nextValue = Math.max(constants.MIN_BPM, Math.min(constants.MAX_BPM, nextValue));
    state.bpm = nextValue;
    dom.bpmInput.value = String(nextValue);
    if (state.metronomeEnabled) {
      stopMetronome();
      startMetronome();
    }
  }

  function onBeatsPerBarChange() {
    let nextValue = parseInt(dom.beatsPerBarInput.value, 10);
    if (isNaN(nextValue) || nextValue < 1) nextValue = 4;
    if (nextValue > 12) nextValue = 12;
    state.beatsPerBar = nextValue;
    dom.beatsPerBarInput.value = String(nextValue);
  }

  function onMetronomeToggle(e) {
    state.metronomeEnabled = e.target.checked;
    if (state.metronomeEnabled) startMetronome(); else stopMetronome();
  }

  function startMetronome() {
    if (state.metronomeInterval || !state.audioContext) return;
    state.metronomeBeatIdx = 0;
    playClick(true);
    state.metronomeBeatIdx = 1;
    const intervalMs = 60000 / state.bpm;
    state.metronomeInterval = setInterval(() => {
      const isDownbeat = state.metronomeBeatIdx % state.beatsPerBar === 0;
      playClick(isDownbeat);
      state.metronomeBeatIdx++;
    }, intervalMs);
  }

  function stopMetronome() {
    if (state.metronomeInterval) {
      clearInterval(state.metronomeInterval);
      state.metronomeInterval = null;
    }
  }

  function playClick(isDownbeat) {
    if (!state.audioContext) return;
    const time = state.audioContext.currentTime;
    const osc = state.audioContext.createOscillator();
    const gain = state.audioContext.createGain();
    osc.frequency.value = isDownbeat ? 1500 : 1000;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(constants.METRONOME_VOLUME, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(gain);
    gain.connect(state.audioContext.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  return {
    onBeatsPerBarChange,
    onBpmChange,
    onMetronomeToggle,
    playClick,
    startMetronome,
    stopMetronome,
  };
}
