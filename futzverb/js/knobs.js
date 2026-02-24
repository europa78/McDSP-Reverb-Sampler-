// knobs.js — reusable knob interaction layer (drag + wheel + keyboard)
//
// Expects HTML structure:
// <div class="knob-container" data-param="Drive" data-min="0" data-max="100" data-value="50">...</div>

import { clamp, toNumber } from './utils.js';

const KNOB_ANGLE_MIN = -90;  // degrees
const KNOB_ANGLE_MAX = 270;  // degrees

function valueToAngle(value, min, max) {
  const range = (max - min);
  if (!Number.isFinite(range) || range === 0) return KNOB_ANGLE_MIN;
  const t = clamp((value - min) / range, 0, 1);
  return KNOB_ANGLE_MIN + t * (KNOB_ANGLE_MAX - KNOB_ANGLE_MIN);
}

function formatKnobValue(param, value, min, max) {
  const p = String(param || '').toLowerCase();

  if (p === 'master') return String(Math.round(value));
  if (p === 'ratio') return `${Math.round(value)}:1`;
  if (p === 'gain' || p === 'makeup') return `+${Math.round(value)}dB`;

  if (p === 'thresh' || p === 'threshold') {
    if (value <= min) return '-inf';
    const t = clamp((value - min) / (max - min || 1), 0, 1);
    const db = -60 + t * 60;
    return `${db.toFixed(0)}dB`;
  }

  if (p.includes('delay time')) return `${Math.round(value)}ms`;
  if (p.includes('delay feedback') || p.includes('delay mix')) return `${Math.round(value)}%`;
  if (p.includes('cut')) return `${Math.round(value)}%`;
  if (min === 0 && max === 100) return `${Math.round(value)}%`;
  return String(Math.round(value * 100) / 100);
}

export function initKnobs({ onChange } = {}) {
  const knobContainers = Array.from(document.querySelectorAll('.knob-container'));

  function setKnobUI(container, value, { emit = true } = {}) {
    const min = toNumber(container.dataset.min, 0);
    const max = toNumber(container.dataset.max, 100);
    const param = container.dataset.param || '';

    const v = clamp(toNumber(value, min), min, max);
    container.dataset.value = String(v);

    const knobEl = container.querySelector('.knob');
    if (knobEl) {
      const angle = valueToAngle(v, min, max);
      knobEl.style.transform = `rotate(${angle.toFixed(1)}deg)`;
    }

    const display = formatKnobValue(param, v, min, max);

    // Update per-module value readout if present
    const group = container.closest('.control-group');
    if (group) {
      const valueEl = group.querySelector('.knob-value');
      if (valueEl) valueEl.textContent = display;
    } else {
      // Master knob: value is next element sibling (green number)
      const next = container.nextElementSibling;
      if (next && next.classList.contains('master-label')) {
        next.textContent = display;
      }
    }

    if (emit && typeof onChange === 'function') {
      onChange(param, v);
    }
  }

  // Init knobs (and store their defaults via onChange)
  knobContainers.forEach((c) => {
    if (!c.hasAttribute('tabindex')) c.setAttribute('tabindex', '0');
    setKnobUI(c, toNumber(c.dataset.value, 0), { emit: true });
  });

  // Drag state (one knob at a time)
  let activeKnob = null;
  let dragStartY = 0;
  let dragStartValue = 0;

  function onKnobPointerDown(e) {
    const c = e.currentTarget;
    e.preventDefault();
    c.classList.add('active');
    c.setPointerCapture?.(e.pointerId);

    activeKnob = c;
    dragStartY = e.clientY;

    const min = toNumber(c.dataset.min, 0);
    dragStartValue = toNumber(c.dataset.value, min);
  }

  function onKnobPointerMove(e) {
    if (!activeKnob || e.currentTarget !== activeKnob) return;

    const c = activeKnob;
    const min = toNumber(c.dataset.min, 0);
    const max = toNumber(c.dataset.max, 100);
    const range = (max - min) || 1;

    const dy = dragStartY - e.clientY; // up = increase
    const pixelsPerFullRange = e.shiftKey ? 750 : 150;
    const delta = (dy / pixelsPerFullRange) * range;

    setKnobUI(c, dragStartValue + delta);
  }

  function onKnobPointerUp(e) {
    const c = e.currentTarget;
    c.classList.remove('active');

    if (activeKnob === c) activeKnob = null;
    try { c.releasePointerCapture?.(e.pointerId); } catch (_) {}
  }

  function onKnobWheel(e) {
    const c = e.currentTarget;
    const min = toNumber(c.dataset.min, 0);
    const max = toNumber(c.dataset.max, 100);
    const range = (max - min) || 1;

    e.preventDefault();
    const step = (e.shiftKey ? range / 500 : range / 200);
    const dir = Math.sign(-e.deltaY || 0);
    const current = toNumber(c.dataset.value, min);

    setKnobUI(c, current + dir * step);
  }

  function onKnobKeyDown(e) {
    const c = e.currentTarget;
    const min = toNumber(c.dataset.min, 0);
    const max = toNumber(c.dataset.max, 100);
    const range = (max - min) || 1;

    const step = (e.shiftKey ? range / 50 : range / 200);
    const current = toNumber(c.dataset.value, min);

    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      setKnobUI(c, current + step);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setKnobUI(c, current - step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setKnobUI(c, min);
    } else if (e.key === 'End') {
      e.preventDefault();
      setKnobUI(c, max);
    }
  }

  // Bind events
  knobContainers.forEach((c) => {
    c.addEventListener('pointerdown', onKnobPointerDown);
    c.addEventListener('pointermove', onKnobPointerMove);
    c.addEventListener('pointerup', onKnobPointerUp);
    c.addEventListener('pointercancel', onKnobPointerUp);
    c.addEventListener('wheel', onKnobWheel, { passive: false });
    c.addEventListener('keydown', onKnobKeyDown);
  });

  return {
    setKnobUI, // exposed for presets later
    getKnobContainers: () => knobContainers
  };
}
