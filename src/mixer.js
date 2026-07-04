import {
  effectiveGain as computeEffectiveGain,
  reverseBuffer as reverseAudioBuffer,
} from './utils.js';

export function createMixer({
  state,
  loops,
  deletedStack,
  dom,
  ui,
  constants,
  getExportLoop,
}) {
  function addLoop(audioBuffer) {
    state.loopCounter++;
    const loop = {
      id: state.loopCounter,
      name: `Loop ${state.loopCounter}`,
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
    ui.renderLoop(loop, {
      onDelete: deleteLoop,
      onExport: (currentLoop) => getExportLoop()(currentLoop),
      onPan: setLoopPan,
      onPlaybackRate: setLoopPlaybackRate,
      onRename: renameLoop,
      onToggleMute: toggleMute,
      onTogglePlay: toggleLoopPlayback,
      onToggleReverse: toggleReverse,
      onToggleSolo: toggleSolo,
      onVolume: setLoopVolume,
    });
    ui.updateEmptyState(loops.length);
  }

  function effectiveGain(loop) {
    return computeEffectiveGain(loop, loops);
  }

  function refreshAllGains() {
    if (!state.audioContext) return;
    const time = state.audioContext.currentTime;
    for (const loop of loops) {
      if (loop.gainNode) {
        loop.gainNode.gain.setTargetAtTime(effectiveGain(loop), time, 0.01);
      }
    }
  }

  function getPlaybackBuffer(loop) {
    if (!loop.reversed) return loop.audioBuffer;
    if (!loop.reversedBuffer) {
      loop.reversedBuffer = reverseAudioBuffer(loop.audioBuffer, state.audioContext);
    }
    return loop.reversedBuffer;
  }

  function playLoop(loop) {
    if (!state.audioContext || loop.playing) return;
    if (state.audioContext.state === 'suspended') state.audioContext.resume();

    const gainNode = state.audioContext.createGain();
    const targetGain = effectiveGain(loop);
    gainNode.gain.value = 0;
    gainNode.gain.setTargetAtTime(targetGain, state.audioContext.currentTime, constants.FADE_TIME);

    const pannerNode = state.audioContext.createStereoPanner
      ? state.audioContext.createStereoPanner()
      : null;
    if (pannerNode) pannerNode.pan.value = loop.pan;

    const sourceNode = state.audioContext.createBufferSource();
    sourceNode.buffer = getPlaybackBuffer(loop);
    sourceNode.loop = true;
    sourceNode.playbackRate.value = loop.playbackRate;

    if (pannerNode) {
      sourceNode.connect(pannerNode);
      pannerNode.connect(gainNode);
    } else {
      sourceNode.connect(gainNode);
    }
    gainNode.connect(state.masterGainNode);

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
      const time = state.audioContext.currentTime;
      gain.gain.cancelScheduledValues(time);
      gain.gain.setTargetAtTime(0, time, constants.FADE_TIME);
    }
    const stopAt = state.audioContext.currentTime + constants.FADE_TIME * 5;
    try {
      node && node.stop(stopAt);
    } catch {
      // ignore already-stopped sources
    }

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

  function toggleLoopPlayback(loop) {
    if (loop.playing) {
      stopLoop(loop);
      return;
    }
    playLoop(loop);
  }

  function deleteLoop(loopId) {
    const idx = loops.findIndex((loop) => loop.id === loopId);
    if (idx === -1) return;
    const loop = loops[idx];
    stopLoop(loop);
    loops.splice(idx, 1);

    deletedStack.push(loop);
    if (deletedStack.length > constants.MAX_UNDO) deletedStack.shift();

    const card = document.getElementById(`loop-card-${loopId}`);
    if (card) card.remove();

    ui.updateEmptyState(loops.length);
    updateUndoButton();
    refreshAllGains();
    ui.showInfo(`Deleted "${loop.name}" – press ↶ Undo (or Ctrl+Z) to restore.`);
  }

  function undoDelete() {
    const loop = deletedStack.pop();
    if (!loop) return;
    loop.node = null;
    loop.gainNode = null;
    loop.pannerNode = null;
    loop.playing = false;
    loops.push(loop);
    ui.renderLoop(loop, {
      onDelete: deleteLoop,
      onExport: (currentLoop) => getExportLoop()(currentLoop),
      onPan: setLoopPan,
      onPlaybackRate: setLoopPlaybackRate,
      onRename: renameLoop,
      onToggleMute: toggleMute,
      onTogglePlay: toggleLoopPlayback,
      onToggleReverse: toggleReverse,
      onToggleSolo: toggleSolo,
      onVolume: setLoopVolume,
    });
    ui.updateEmptyState(loops.length);
    updateUndoButton();
    refreshAllGains();
    ui.setStatus(`Restored "${loop.name}".`);
  }

  function updateUndoButton() {
    dom.btnUndo.disabled = deletedStack.length === 0;
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
      loop.pannerNode.pan.setTargetAtTime(value, state.audioContext.currentTime, 0.01);
    }
  }

  function setLoopPlaybackRate(loop, value) {
    loop.playbackRate = value;
    if (loop.node) {
      loop.node.playbackRate.setTargetAtTime(value, state.audioContext.currentTime, 0.01);
    }
  }

  function toggleReverse(loop) {
    loop.reversed = !loop.reversed;
    const wasPlaying = loop.playing;
    if (wasPlaying) {
      stopLoop(loop);
      setTimeout(() => playLoop(loop), Math.ceil(constants.FADE_TIME * 1000 * 6));
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
    loops.forEach((loop) => playLoop(loop));
  }

  function stopAllLoops() {
    loops.forEach((loop) => stopLoop(loop));
  }

  function onMasterVolumeChange(e) {
    state.masterVolume = parseFloat(e.target.value);
    if (state.masterGainNode) {
      state.masterGainNode.gain.setTargetAtTime(state.masterVolume, state.audioContext.currentTime, 0.01);
    }
  }

  return {
    addLoop,
    effectiveGain,
    getPlaybackBuffer,
    onMasterVolumeChange,
    playAllLoops,
    playLoop,
    refreshAllGains,
    renameLoop,
    setLoopPan,
    setLoopPlaybackRate,
    setLoopVolume,
    stopAllLoops,
    stopLoop,
    toggleLoopPlayback,
    undoDelete,
    updateUndoButton,
  };
}
