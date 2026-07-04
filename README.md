# TottiLooper

A browser-based audio looper for solo musicians. Record short riffs and layer
them on top of each other – your one-man band for busking starts here.

## Features

### Recording & tempo
- 🎤 **Record** audio loops directly from your microphone
- 📈 **Input level meter** so you can set a healthy recording level
- 🎚️ **First-loop tempo detection** to suggest a session BPM from your opening take
- 🎧 **Input monitoring toggle** with **latency offset** trim for live self-monitoring
- 🥁 **Built-in metronome** with adjustable **BPM** and **beats-per-bar**
- 🥁 **Generate drum backing loops** from BPM + style using built-in one-shot samples
- ⏱️ **Count-in** before recording so your first note isn't clipped
- 📐 **Quantize** recorded loops to whole bars for perfectly aligned layers
- ⏱️ **Live recording timer** + one-click **Discard**

### Mixer
- 🎵 **Layer** as many loops as you like, playing simultaneously
- 🎼 **Likely key detection** on recorded loops, with a warning when a new layer may clash
- 🎚️ **Per-loop volume, pan, 3-band EQ, and playback-speed (pitch)** sliders
- 🎚️ **Master volume** for overall level
- 🎛️ **Web MIDI learn** for record/play controls, loop toggles, and per-loop volume faders
- 🔇 **Mute**, **S** Solo, and **⇄ Reverse** toggles on every loop
- ▶ **Play / Stop** each loop independently or **Play All / Stop All** together
- 🖊️ **Rename loops** (e.g. "Bass", "Chords", "Beatbox")
- 📊 **Waveform preview** for each recorded loop
- ✨ Click-free start/stop with short automatic fades

### Save, share, recover
- ⬇ **Export the full mix as WAV** (rendered via `OfflineAudioContext`)
- ⬇ **Export any individual loop as WAV**
- 🔗 **Share small sessions via URL** – encodes loop audio + mixer state into the link fragment
- ↶ **Undo delete** – last 20 deleted loops can be restored (also `Ctrl`+`Z`)
- 📲 **Install to your home screen** with offline-ready cached assets

### Accessibility & UX
- ⌨️ **Keyboard shortcuts** for all common actions (see Help)
- 🦶 **Gamepad / USB foot-switch support** via the Gamepad API for hands-free control
- 🏷️ `aria-label` / `aria-pressed` on every icon-only control
- ❓ **Built-in Help / tutorial modal** with step-by-step instructions

## Usage

1. Open `index.html` in a modern browser (Chrome, Firefox, Edge, Safari 14+).
2. Click **🎤 Allow Microphone** and grant permission when prompted.
3. (Optional) Enable **Monitor input** if you want to hear yourself live, then
   adjust **Latency offset** to compensate if overdubs land slightly early or late.
4. (Optional) Set your **BPM**, then enable **Metronome**, **Count-in** and
   **Quantize** if you want bar-locked loops.
4. (Optional) Pick a **Drum style** and click **🥁 Generate drums** to add a
   backing groove that follows the current BPM.
5. Click **● REC** (or press <kbd>Space</kbd>) to start recording a riff.
6. Click **■ STOP** (or press <kbd>Space</kbd> again) when you're done – the
   loop is saved automatically and appears in the list.
7. Click **▶** on a loop card to start it playing (it will loop continuously).
8. Drag **Vol / Pan / Low / Mid / High / Speed** sliders to mix, shape tone, **S** to solo, **⇄** to reverse.
9. Record more riffs and stack them up to build your sound.
10. Use **▶ Play All / ■ Stop All** to control everything at once.
11. Click **Enable MIDI** and use **Learn** if you want to map controller pads, buttons, or faders.
12. Click **🔗 Share** to copy a URL for a small session, or **⬇ Export** to save the current mix as a WAV file.

Click the **?** button in the top-right corner (or press <kbd>?</kbd>) at any
time to open the in-app tutorial.

### Keyboard shortcuts

You can remap every shortcut from the Help modal, and your custom bindings are
saved in `localStorage` for the next visit.

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Start / stop recording |
| <kbd>Enter</kbd> | Play all loops |
| <kbd>Esc</kbd> | Stop all loops |
| <kbd>1</kbd> … <kbd>9</kbd> | Toggle loops 1 through 9 |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>⌘</kbd>+<kbd>Z</kbd> | Undo the last delete |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> / <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Redo the last undo |
| <kbd>?</kbd> | Open the Help modal |

### Gamepad / foot-switch controls

If your browser exposes a connected USB foot switch or gamepad through the
Gamepad API, the first four buttons (indices 0–3) map to:

| Button | Action |
| --- | --- |
| 1 | Start / stop recording |
| 2 | Play all loops |
| 3 | Stop all loops |
| 4 | Toggle the next loop, cycling through the recorded loops |

### Tip: use headphones

Without headphones your microphone will re-record whatever the speakers are
already playing back, bleeding old loops into new ones. Use headphones
(ideally closed-back) for clean layers.

## Running locally

Because the app uses `getUserMedia`, it must be served over HTTPS or
`localhost`. The simplest way to run it locally:

```bash
# Python 3
python3 -m http.server 8080
# then open http://localhost:8080 in your browser
```

Or use any static-file server (e.g. `npx serve .`).

## Browser support

Requires a browser with support for:
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
  (including `StereoPannerNode` and `OfflineAudioContext`)
- [MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API)
- [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Web MIDI API](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API) for controller mapping

All modern browsers (Chrome 66+, Firefox 57+, Edge 79+, Safari 14.1+) are
supported.
