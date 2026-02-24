// app.js — entry point: wires UI + knobs + audio + sampler

import { createAudioEngine } from './audio.js';
import { initKnobs } from './knobs.js';
import { createSampler } from './sampler.js';

document.addEventListener('DOMContentLoaded', () => {
  // 1) Audio engine
  const audio = createAudioEngine();

  // 2) Knobs: store values immediately; apply to audio once AudioContext exists
  initKnobs({
    onChange: (param, value) => {
      audio.setParam(param, value);
    }
  });

  // 3) Sampler / transport / waveform
  const els = {
    canvas: document.getElementById('waveformCanvas'),
    playBtn: document.getElementById('playBtn'),
    stopBtn: document.getElementById('stopBtn'),
    loopBtn: document.getElementById('loopBtn'),
    importBtn: document.getElementById('importBtn'),
    fileInput: document.getElementById('audioFileInput'),
    sampleList: document.getElementById('sampleList'),
  };

  const sampler = createSampler(audio, els);
  sampler.init();

  // Future: expose these on window for quick console debugging
  window.__futzverb = { audio, sampler };
});
