import { audioBufferToWav } from './utils.js';

export function createExporter({ state, loops, ui, mixer }) {
  async function exportMix() {
    if (loops.length === 0) {
      ui.showInfo('Nothing to export – record a loop first.');
      return;
    }
    ui.setStatus('Rendering mix…');

    const sampleRate = state.audioContext.sampleRate;
    const maxLoopDuration = loops.reduce((maxDuration, loop) => {
      return Math.max(maxDuration, loop.duration / loop.playbackRate);
    }, 0);
    const duration = Math.max(4, Math.min(60, Math.ceil(maxLoopDuration * 4)));

    const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
    const offlineMaster = offline.createGain();
    offlineMaster.gain.value = state.masterVolume;
    offlineMaster.connect(offline.destination);

    for (const loop of loops) {
      const gainValue = mixer.effectiveGain(loop);
      if (gainValue === 0) continue;

      const source = offline.createBufferSource();
      source.buffer = mixer.getPlaybackBuffer(loop);
      source.loop = true;
      source.playbackRate.value = loop.playbackRate;

      const gainNode = offline.createGain();
      gainNode.gain.value = gainValue;

      if (offline.createStereoPanner) {
        const panner = offline.createStereoPanner();
        panner.pan.value = loop.pan;
        source.connect(panner);
        panner.connect(gainNode);
      } else {
        source.connect(gainNode);
      }
      gainNode.connect(offlineMaster);
      source.start(0);
    }

    try {
      const rendered = await offline.startRendering();
      const wavBlob = audioBufferToWav(rendered);
      downloadBlob(wavBlob, `tottilooper-mix-${Date.now()}.wav`);
      ui.setStatus('Mix exported.');
    } catch (err) {
      ui.showError('Export failed: ' + err.message);
      ui.setStatus('Ready.');
    }
  }

  function exportLoop(loop) {
    const wavBlob = audioBufferToWav(mixer.getPlaybackBuffer(loop));
    const safeName = loop.name.replace(/[^a-z0-9_-]+/gi, '_') || `loop-${loop.id}`;
    downloadBlob(wavBlob, `${safeName}.wav`);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    exportLoop,
    exportMix,
  };
}
