# TottiLooper

A browser-based audio looper for solo musicians. Record short riffs and layer
them on top of each other – your one-man band for busking starts here.

## Features

- 🎤 **Record** audio loops directly from your microphone
- 🎵 **Layer** multiple loops playing simultaneously
- ▶ **Per-loop controls** – play / stop / mute each loop independently
- 🔊 **Master play / stop all** loops with one click
- 📊 **Waveform preview** for each recorded loop
- ✕ **Delete** loops you don't need any more

## Usage

1. Open `index.html` in a modern browser (Chrome, Firefox, Edge, Safari 14+).
2. Click **Allow Microphone** and grant permission when prompted.
3. Click **● REC** to start recording a riff.
4. Click **■ STOP** (or **● REC** again) when you're done – the loop is saved automatically and starts showing in the list.
5. Click **▶** on a loop card to start it playing (it will loop continuously).
6. Record more riffs and stack them to build up your sound.
7. Use **▶ Play All** / **■ Stop All** to control everything at once.
8. Click **🔊** to mute individual loops, or **✕** to delete them.

## Running locally

Because the app uses `getUserMedia`, it must be served over HTTPS or `localhost`.
The simplest way to run it locally:

```bash
# Python 3
python3 -m http.server 8080
# then open http://localhost:8080 in your browser
```

Or use any static-file server (e.g. `npx serve .`).

## Browser support

Requires a browser with support for:
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

All modern browsers (Chrome 66+, Firefox 57+, Edge 79+, Safari 14.1+) are supported.
