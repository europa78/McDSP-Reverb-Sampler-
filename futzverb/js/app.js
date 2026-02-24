// app.js — entry point: wires UI + knobs + audio + sampler

import { createAudioEngine } from './audio.js';
import { initKnobs } from './knobs.js';
import { createSampler } from './sampler.js';

function updateDelayMorphDisplay() {
  const display = document.getElementById('delayMorphDisplay');
  if (!display) return;

  const time = Number(display.dataset.delayTime ?? 320);
  const feedback = Number(display.dataset.delayFeedback ?? 45);
  const mix = Number(display.dataset.delayMix ?? 35);

  const timeNorm = Math.min(Math.max((time - 20) / 1180, 0), 1);
  const feedbackNorm = Math.min(Math.max(feedback / 90, 0), 1);
  const mixNorm = Math.min(Math.max(mix / 100, 0), 1);

  display.style.setProperty('--delay-time', timeNorm.toFixed(3));
  display.style.setProperty('--delay-feedback', feedbackNorm.toFixed(3));
  display.style.setProperty('--delay-mix', mixNorm.toFixed(3));
}

document.addEventListener('DOMContentLoaded', () => {
  // 1) Audio engine
  const audio = createAudioEngine();

  // 2) Knobs: store values immediately; apply to audio once AudioContext exists
  initKnobs({
    onChange: (param, value) => {
      audio.setParam(param, value);

      const display = document.getElementById('delayMorphDisplay');
      if (display) {
        if (param === 'Delay Time') display.dataset.delayTime = String(value);
        if (param === 'Delay Feedback') display.dataset.delayFeedback = String(value);
        if (param === 'Delay Mix') display.dataset.delayMix = String(value);
      }
      updateDelayMorphDisplay();
    }
  });

  updateDelayMorphDisplay();

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
