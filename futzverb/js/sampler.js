// sampler.js — sample import + waveform region + transport (play/stop/loop)

import { clamp } from './utils.js';

export function createSampler(audio, els) {
  let currentBuffer = null;
  let sourceNode = null;
  let isPlaying = false;
  let isLooping = false;

  // Waveform/Editing State
  let regionStart = 0.0; // 0..1
  let regionEnd = 1.0;   // 0..1
  let isDraggingStart = false;
  let isDraggingEnd = false;

  const canvas = els.canvas;
  const ctx = canvas?.getContext?.('2d');

  function resetRegion() {
    regionStart = 0.0;
    regionEnd = 1.0;
  }

  function setActiveListItem(li) {
    document.querySelectorAll('#sampleList li').forEach(i => i.classList.remove('active'));
    li.classList.add('active');
    li.scrollIntoView({ behavior: 'smooth' });
  }

  function decodeArrayBuffer(arrayBuffer) {
    const ac = audio.getContext();
    return new Promise((resolve, reject) => {
      if (!ac) return reject(new Error('AudioContext not initialized'));
      // Modern browsers: Promise form when callbacks not provided.
      try {
        if (ac.decodeAudioData.length === 1) {
          ac.decodeAudioData(arrayBuffer).then(resolve).catch(reject);
        } else {
          ac.decodeAudioData(arrayBuffer, resolve, reject);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  function importInit() {
    const { importBtn, fileInput, sampleList } = els;

    importBtn?.addEventListener('click', () => {
      audio.init();
      fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const li = document.createElement('li');
      li.textContent = file.name;
      li.dataset.type = 'imported';

      sampleList.appendChild(li);
      setActiveListItem(li);

      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          audio.init();
          const ac = audio.getContext();
          const buffer = await decodeArrayBuffer(ev.target.result);
          currentBuffer = buffer;
          resetRegion();
          drawWaveform();
          audio.ensureFx(); // make sure routing is ready
          audio.applyAll(); // apply stored knob defaults
        } catch (err) {
          console.error('Error decoding audio', err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function createProceduralBuffer() {
    const ac = audio.getContext();
    if (!ac) return;

    const sampleRate = ac.sampleRate;
    const frameCount = Math.floor(sampleRate * 2.0);
    const buffer = ac.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < frameCount; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-3 * i / frameCount);
    }
    currentBuffer = buffer;
    resetRegion();
    drawWaveform();
  }

  function stop() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch (e) {}
      try { sourceNode.disconnect(); } catch (e) {}
      sourceNode = null;
    }
    isPlaying = false;
    els.playBtn?.classList.remove('playing');
  }

  function updateSourceLoopingFromRegion() {
    if (!sourceNode || !currentBuffer) return;

    const duration = currentBuffer.duration * (regionEnd - regionStart);
    const offset = currentBuffer.duration * regionStart;

    sourceNode.loop = isLooping;
    if (isLooping) {
      sourceNode.loopStart = offset;
      sourceNode.loopEnd = offset + duration;
    }
  }

  function updateLoopButtonUI() {
    const { loopBtn } = els;
    if (!loopBtn) return;
    loopBtn.classList.toggle('looping', isLooping);
    loopBtn.setAttribute('aria-pressed', String(isLooping));
    loopBtn.title = isLooping ? 'Loop: On' : 'Loop: Off';
  }

  function play() {
    audio.init();
    audio.ensureFx();
    audio.applyAll();

    if (!currentBuffer && !isPlaying) {
      createProceduralBuffer();
    }
    if (!currentBuffer) return;

    stop();

    const ac = audio.getContext();
    sourceNode = ac.createBufferSource();
    sourceNode.buffer = currentBuffer;

    // Route through FX graph
    audio.connectSource(sourceNode);

    const duration = currentBuffer.duration * (regionEnd - regionStart);
    const offset = currentBuffer.duration * regionStart;

    sourceNode.loop = isLooping;
    if (isLooping) {
      sourceNode.loopStart = offset;
      sourceNode.loopEnd = offset + duration;
      sourceNode.start(0, offset);
    } else {
      sourceNode.start(0, offset, duration);
    }

    isPlaying = true;
    els.playBtn?.classList.add('playing');

    if (!isLooping) {
      sourceNode.onended = () => {
        isPlaying = false;
        els.playBtn?.classList.remove('playing');
      };
    }
  }

  function toggleLoop() {
    isLooping = !isLooping;
    updateLoopButtonUI();
    updateSourceLoopingFromRegion();
  }

  function transportInit() {
    updateLoopButtonUI();
    els.playBtn?.addEventListener('click', play);
    els.stopBtn?.addEventListener('click', stop);
    els.loopBtn?.addEventListener('click', toggleLoop);

    // Keyboard shortcut: "L" toggles loop (when not typing)
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key && e.key.toLowerCase() === 'l') {
        toggleLoop();
      }
    });
  }

  function drawWaveform() {
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    // Important: setTransform prevents transform compounding on repeated draws
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = rect.width;
    const height = rect.height;
    const centerY = height / 2;

    ctx.clearRect(0, 0, width, height);

    if (!currentBuffer) return;

    const data = currentBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    const startX = Math.floor(regionStart * width);
    const endX = Math.floor(regionEnd * width);

    // Pass 1: dimmed waveform
    ctx.fillStyle = '#2a3a2a';
    for (let i = 0; i < width; i += 2) {
      let min = 1.0, max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = data[(i * step) + j] || 0;
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      const barHeight = (max - min) * amp;
      const y = centerY - (barHeight / 2);
      ctx.fillRect(i, y, 1.5, barHeight);
    }

    // Pass 2: bright waveform in region
    ctx.fillStyle = '#4ade80';
    for (let i = startX; i < endX; i += 2) {
      let min = 1.0, max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = data[(i * step) + j] || 0;
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      const barHeight = (max - min) * amp;
      const y = centerY - (barHeight / 2);
      ctx.fillRect(i, y, 1.5, barHeight);
    }

    // Pass 3: markers
    ctx.fillStyle = '#fff';

    // Start handle
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(startX - 6, 8);
    ctx.lineTo(startX + 6, 8);
    ctx.fill();
    ctx.fillRect(startX - 1, 8, 2, height - 16);

    // End handle
    ctx.beginPath();
    ctx.moveTo(endX, height);
    ctx.lineTo(endX - 6, height - 8);
    ctx.lineTo(endX + 6, height - 8);
    ctx.fill();
    ctx.fillRect(endX - 1, 8, 2, height - 16);
  }

  function handleHit(x) {
    const width = canvas.width / (window.devicePixelRatio || 1);
    const startX = regionStart * width;
    const endX = regionEnd * width;
    const threshold = 10;

    if (Math.abs(x - startX) < threshold) return 'start';
    if (Math.abs(x - endX) < threshold) return 'end';
    return null;
  }

  function markerInit() {
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const hit = handleHit(x);

      if (hit === 'start') isDraggingStart = true;
      if (hit === 'end') isDraggingEnd = true;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDraggingStart && !isDraggingEnd) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const hit = handleHit(x);
        canvas.style.cursor = hit ? 'ew-resize' : 'default';
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const width = rect.width;
      const percent = clamp(x / width, 0, 1);

      if (isDraggingStart) {
        regionStart = Math.min(percent, regionEnd - 0.01);
        drawWaveform();
        updateSourceLoopingFromRegion();
      } else if (isDraggingEnd) {
        regionEnd = Math.max(percent, regionStart + 0.01);
        drawWaveform();
        updateSourceLoopingFromRegion();
      }
    });

    window.addEventListener('mouseup', () => {
      isDraggingStart = false;
      isDraggingEnd = false;
    });
  }

  function listInit() {
    // Default list items (if any) still exist in HTML
    document.querySelectorAll('#sampleList li').forEach((item) => {
      item.addEventListener('click', () => {
        setActiveListItem(item);

        // Reset buffer for default items
        if (item.dataset.type === 'default') {
          currentBuffer = null; // generates on play
          resetRegion();
          drawWaveform();
        }
      });
    });
  }

  function resizeInit() {
    window.addEventListener('resize', drawWaveform);
  }

  function init() {
    importInit();
    transportInit();
    markerInit();
    listInit();
    resizeInit();
    drawWaveform();
  }

  return {
    init,
    play,
    stop,
    toggleLoop,
    getState: () => ({ isPlaying, isLooping, regionStart, regionEnd })
  };
}
