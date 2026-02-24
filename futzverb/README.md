# FutzVerb (WebAudio) — Sampler + FX Chain

A single‑page “plugin style” UI that loads a sample and routes playback through:
**Distortion → Reverb → Dynamics → Master**.

This repo is intentionally **no-build / no-framework**: plain HTML + CSS + ES modules.

## Run locally

Because browsers restrict some file features, use a tiny local server:

### Option A: Python
```bash
cd futzverb
python -m http.server 5173
```
Open: http://localhost:5173

### Option B: Node
```bash
npx serve .
```

## Deploy on GitHub Pages
1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages**
3. Deploy from branch (e.g. `main`) and folder `/root`

## Project structure

- `index.html` — UI markup
- `css/styles.css` — styling
- `js/app.js` — bootstraps the app
- `js/knobs.js` — knob interaction layer (drag/wheel/keys)
- `js/audio.js` — WebAudio FX graph + parameter mapping
- `js/sampler.js` — sample import, waveform, region markers, transport + looping
- `js/utils.js` — helpers

## Notes
- Knob values are stored immediately; audio parameters apply once the `AudioContext` is created (on user gesture).
- Loop button loops the selected region (start/end markers).

