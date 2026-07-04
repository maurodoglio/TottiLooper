export function createUI({ dom, formatDuration, panText }) {
  let toastTimeout = null;

  function openHelp() {
    dom.helpModal.classList.remove('hidden');
  }

  function closeHelp() {
    dom.helpModal.classList.add('hidden');
  }

  function setStatus(msg) {
    dom.statusText.textContent = msg;
  }

  function showError(msg) {
    showToast(msg, false);
  }

  function showInfo(msg) {
    showToast(msg, true);
  }

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

  function renderLoop(loop, handlers) {
    const card = document.createElement('div');
    card.className = 'loop-card';
    card.id = `loop-card-${loop.id}`;
    if (loop.muted) card.classList.add('muted');
    if (loop.soloed) card.classList.add('soloed');

    const topRow = document.createElement('div');
    topRow.className = 'loop-top';

    const nameInput = document.createElement('input');
    nameInput.className = 'loop-name';
    nameInput.type = 'text';
    nameInput.value = loop.name;
    nameInput.title = 'Rename loop';
    nameInput.setAttribute('aria-label', 'Loop name');
    nameInput.addEventListener('change', () => {
      handlers.onRename(loop, nameInput.value);
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
      () => handlers.onTogglePlay(loop),
    );
    if (loop.playing) btnPlay.classList.add('active');

    const btnMute = iconButton(
      'btn-mute',
      loop.muted ? '🔇' : '🔊',
      loop.muted ? 'Unmute' : 'Mute',
      () => handlers.onToggleMute(loop),
    );
    btnMute.setAttribute('aria-pressed', loop.muted ? 'true' : 'false');
    if (loop.muted) btnMute.classList.add('active');

    const btnSolo = iconButton('btn-solo', 'S', 'Solo', () => handlers.onToggleSolo(loop));
    btnSolo.setAttribute('aria-pressed', loop.soloed ? 'true' : 'false');
    if (loop.soloed) btnSolo.classList.add('active');

    const btnReverse = iconButton('btn-reverse', '⇄', 'Reverse', () => handlers.onToggleReverse(loop));
    btnReverse.setAttribute('aria-pressed', loop.reversed ? 'true' : 'false');
    if (loop.reversed) btnReverse.classList.add('active');

    const btnExport = iconButton('btn-export', '⬇', 'Export as WAV', () => handlers.onExport(loop));

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn-danger';
    btnDelete.textContent = '✕';
    btnDelete.title = 'Delete loop';
    btnDelete.setAttribute('aria-label', 'Delete loop');
    btnDelete.addEventListener('click', () => handlers.onDelete(loop.id));

    actions.append(btnPlay, btnMute, btnSolo, btnReverse, btnExport, btnDelete);
    topRow.append(nameInput, waveformEl, durationEl, actions);

    const faderRow = document.createElement('div');
    faderRow.className = 'loop-faders';
    faderRow.append(
      makeFader('Vol', 0, 1.5, 0.01, loop.volume, (v) => `${Math.round(v * 100)}%`, (v) => handlers.onVolume(loop, v)),
      makeFader('Pan', -1, 1, 0.01, loop.pan, panText, (v) => handlers.onPan(loop, v)),
      makeFader('Speed', 0.5, 2, 0.01, loop.playbackRate, (v) => `${v.toFixed(2)}×`, (v) => handlers.onPlaybackRate(loop, v)),
    );

    card.appendChild(topRow);
    card.appendChild(faderRow);

    dom.loopsList.appendChild(card);
    drawWaveform(canvas, loop.audioBuffer);
  }

  function iconButton(cls, text, title, onClick) {
    const button = document.createElement('button');
    button.className = 'btn-icon ' + cls;
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  }

  function makeFader(label, min, max, step, value, formatValue, onInput) {
    const wrap = document.createElement('label');
    wrap.className = 'fader';

    const title = document.createElement('span');
    title.className = 'fader-label';
    title.textContent = label;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);

    const valueEl = document.createElement('span');
    valueEl.className = 'fader-value';
    valueEl.textContent = formatValue(value);

    input.addEventListener('input', () => {
      const nextValue = parseFloat(input.value);
      valueEl.textContent = formatValue(nextValue);
      onInput(nextValue);
    });

    wrap.append(title, input, valueEl);
    return wrap;
  }

  function drawWaveform(canvas, audioBuffer) {
    const data = audioBuffer.getChannelData(0);
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.offsetWidth || 200;
    const height = canvas.offsetHeight || 34;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const step = Math.max(1, Math.ceil(data.length / width));
    const mid = height / 2;

    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#e84040';
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let x = 0; x < width; x++) {
      let min = 1;
      let max = -1;
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

  function updateEmptyState(loopCount) {
    dom.emptyState.style.display = loopCount === 0 ? 'block' : 'none';
  }

  return {
    closeHelp,
    openHelp,
    renderLoop,
    setStatus,
    showError,
    showInfo,
    updateEmptyState,
  };
}
