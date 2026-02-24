// audio.js — WebAudio engine + FX graph
// Routes: input -> driveGain -> waveshaper -> toneFilter -> distLevel -> (dry + wet)
// wet: preDelay -> modDelay -> convolver -> lowCut -> highCut -> wetGain
// sum -> compressor -> makeup -> master -> destination

import { clamp, toNumber, dbToGain } from './utils.js';

export function createAudioEngine() {
  let audioContext = null;

  // FX graph state
  let fx = null; // { input, output, nodes }
  const knobState = Object.create(null);
  let reverbRegenTimer = null;

  function init() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    return audioContext;
  }

  function getContext() {
    return audioContext;
  }

  function makeDistortionCurve(amount) {
    // amount: 0..1
    const k = 1 + amount * 60; // higher = more distortion
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
    }
    return curve;
  }

  function createImpulseResponse({ seconds, diffusion }) {
    // seconds: length of IR; diffusion: 0..1 controls envelope curvature/density
    const sr = audioContext.sampleRate;
    const length = Math.max(1, Math.floor(sr * seconds));
    const ir = audioContext.createBuffer(2, length, sr);

    // Diffusion affects how quickly energy decays early vs late
    const diffExp = 0.8 + diffusion * 3.2; // 0.8..4.0

    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, diffExp);
        data[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return ir;
  }

  function regenReverbNow() {
    if (!audioContext || !fx) return;

    // Read knobs (fallback defaults)
    const size = toNumber(knobState['Size'] ?? 30, 30);      // 0..100
    const decay = toNumber(knobState['Decay'] ?? 85, 85);    // 0..100
    const diff  = toNumber(knobState['Diff'] ?? 75, 75);     // 0..100

    const sizeNorm  = clamp(size / 100, 0, 1);
    const decayNorm = clamp(decay / 100, 0, 1);
    const diffNorm  = clamp(diff / 100, 0, 1);

    // IR length: small rooms shorter, bigger rooms longer; decay dominates tail
    const seconds = clamp(0.35 + sizeNorm * 1.1 + decayNorm * 7.0, 0.35, 10.0);
    fx.nodes.convolver.buffer = createImpulseResponse({ seconds, diffusion: diffNorm });
  }

  function scheduleReverbRegen(force = false) {
    if (!audioContext || !fx) return;
    if (force) {
      regenReverbNow();
      return;
    }
    if (reverbRegenTimer) clearTimeout(reverbRegenTimer);
    reverbRegenTimer = setTimeout(() => {
      regenReverbNow();
      reverbRegenTimer = null;
    }, 80);
  }

  function applyKnobToAudio(param, value) {
    if (!audioContext || !fx) return;
    const t = audioContext.currentTime;
    const n = fx.nodes;
    const v = toNumber(value, 0);

    switch (param) {
      // --- Distortion ---
      case 'Drive': {
        const norm = clamp(v / 100, 0, 1);
        n.driveGain.gain.setTargetAtTime(1 + norm * 19, t, 0.01);
        n.shaper.curve = makeDistortionCurve(norm);
        break;
      }
      case 'Tone': {
        const norm = clamp(v / 100, 0, 1);
        const cutoff = 500 * Math.pow(24, norm); // ~500..12000
        n.toneFilter.frequency.setTargetAtTime(cutoff, t, 0.01);
        n.toneFilter.Q.setTargetAtTime(0.5 + norm * 1.5, t, 0.01);
        break;
      }
      case 'Level': {
        const norm = clamp(v / 100, 0, 1);
        n.distLevel.gain.setTargetAtTime(norm * 1.6, t, 0.01);
        break;
      }

      // --- Reverb ---
      case 'Size': {
        const norm = clamp(v / 100, 0, 1);
        n.preDelay.delayTime.setTargetAtTime(norm * 0.06, t, 0.01);

        // Wet/dry derived from size (bigger room => more wet)
        const wet = clamp(0.10 + norm * 0.75, 0.10, 0.90);
        const dry = clamp(1.0 - wet * 0.65, 0.15, 1.0);
        n.wetGain.gain.setTargetAtTime(wet, t, 0.02);
        n.dryGain.gain.setTargetAtTime(dry, t, 0.02);

        scheduleReverbRegen();
        break;
      }
      case 'Diff':
      case 'Decay': {
        scheduleReverbRegen();
        break;
      }
      case 'Mod': {
        const norm = clamp(v / 100, 0, 1);
        const rate = 0.2 + norm * 2.0;   // 0.2..2.2 Hz
        const depth = norm * 0.008;      // 0..8ms
        n.lfo.frequency.setTargetAtTime(rate, t, 0.02);
        n.lfoGain.gain.setTargetAtTime(1.0, t, 0.02);
        n.modDelay.delayTime.setTargetAtTime(0.010, t, 0.02);
        n.modDepth.gain.setTargetAtTime(depth, t, 0.02);
        break;
      }
      case 'Low Cut': {
        const norm = clamp(v / 100, 0, 1);
        const fc = 20 * Math.pow(40, norm); // ~20..800
        n.lowCut.frequency.setTargetAtTime(fc, t, 0.02);
        n.lowCut.Q.setTargetAtTime(0.7, t, 0.02);
        break;
      }
      case 'High Cut': {
        const norm = clamp(v / 100, 0, 1);
        const fc = 16000 * Math.pow(0.0625, 1 - norm); // ~1000..16000
        n.highCut.frequency.setTargetAtTime(fc, t, 0.02);
        n.highCut.Q.setTargetAtTime(0.7, t, 0.02);
        break;
      }

      // --- Dynamics ---
      case 'Thresh': {
        const thr = -60 + (clamp(v / 100, 0, 1) * 60);
        n.compressor.threshold.setTargetAtTime(thr, t, 0.02);
        break;
      }
      case 'Ratio': {
        n.compressor.ratio.setTargetAtTime(clamp(v, 1, 20), t, 0.02);
        break;
      }
      case 'Gain': {
        const g = dbToGain(clamp(v, 0, 24));
        n.makeupGain.gain.setTargetAtTime(g, t, 0.02);
        break;
      }

      // --- Master ---
      case 'Master': {
        const norm = clamp(v / 100, 0, 1);
        n.masterGain.gain.setTargetAtTime(Math.pow(norm, 1.6), t, 0.02);
        break;
      }
    }
  }

  function applyAll() {
    if (!audioContext) return;
    ensureFx();
    Object.keys(knobState).forEach((p) => applyKnobToAudio(p, knobState[p]));
  }

  function ensureFx() {
    if (!audioContext) return null;
    if (fx) return fx;

    const input = audioContext.createGain();

    // Distortion stage
    const driveGain = audioContext.createGain();
    const shaper = audioContext.createWaveShaper();
    shaper.oversample = '4x';
    const toneFilter = audioContext.createBiquadFilter();
    toneFilter.type = 'lowpass';
    const distLevel = audioContext.createGain();

    // Reverb stage (with predelay + optional modulation)
    const preDelay = audioContext.createDelay(0.2);
    const modDelay = audioContext.createDelay(0.05);
    const modDepth = audioContext.createGain();
    const lfo = audioContext.createOscillator();
    const lfoGain = audioContext.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 0.8;
    lfoGain.gain.value = 0.0;
    lfo.connect(lfoGain);
    lfoGain.connect(modDepth);
    modDepth.connect(modDelay.delayTime);
    lfo.start();

    const convolver = audioContext.createConvolver();

    // Post-reverb EQ
    const lowCut = audioContext.createBiquadFilter();
    lowCut.type = 'highpass';
    const highCut = audioContext.createBiquadFilter();
    highCut.type = 'lowpass';

    // Wet/Dry mix (derived from Size knob)
    const dryGain = audioContext.createGain();
    const wetGain = audioContext.createGain();

    // Dynamics + output
    const compressor = audioContext.createDynamicsCompressor();
    compressor.knee.value = 24;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.18;

    const makeupGain = audioContext.createGain();
    const masterGain = audioContext.createGain();

    // Wire it up
    input.connect(driveGain);
    driveGain.connect(shaper);
    shaper.connect(toneFilter);
    toneFilter.connect(distLevel);

    distLevel.connect(dryGain);

    distLevel.connect(preDelay);
    preDelay.connect(modDelay);
    modDelay.connect(convolver);
    convolver.connect(lowCut);
    lowCut.connect(highCut);
    highCut.connect(wetGain);

    const sum = audioContext.createGain();
    dryGain.connect(sum);
    wetGain.connect(sum);

    sum.connect(compressor);
    compressor.connect(makeupGain);
    makeupGain.connect(masterGain);
    masterGain.connect(audioContext.destination);

    fx = {
      input,
      output: masterGain,
      nodes: {
        driveGain, shaper, toneFilter, distLevel,
        preDelay, modDelay, modDepth, lfo, lfoGain,
        convolver, lowCut, highCut,
        dryGain, wetGain,
        compressor, makeupGain, masterGain,
        sum
      }
    };

    // Initialize node params from current knob positions and build initial IR
    applyAll();
    scheduleReverbRegen(true);

    return fx;
  }

  function setParam(param, value) {
    if (!param) return;
    knobState[param] = toNumber(value, 0);

    if (!audioContext) return; // store now, apply later
    ensureFx();
    applyKnobToAudio(param, knobState[param]);
  }

  function connectSource(sourceNode) {
    if (!audioContext) return;
    ensureFx();
    sourceNode.connect(fx.input);
  }

  function getParam(param) {
    return knobState[param];
  }

  return {
    init,
    getContext,
    ensureFx,
    setParam,
    getParam,
    applyAll,
    connectSource,
  };
}
