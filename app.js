import { clamp, toNumber, dbToGain } from "./js/modules/math.js";
import { createImpulseResponse } from "./js/modules/reverb-utils.js";
import { encodeWavFromChannels } from "./js/modules/wav.js";

        document.addEventListener('DOMContentLoaded', () => {
            // --- Global State ---
            let audioContext = null;

            // FX graph state (built on-demand once audioContext exists)
            let fx = null; // { input, output, nodes... }
            const knobState = Object.create(null);
            let reverbRegenTimer = null;
            let hasLoggedReverbSanity = false;
            let isMasterBypassed = false;
            const moduleModeState = {
                distortion: 'fuzz',
                preverb: 'freeze',
                delay: 'digital',
                reverb: 'plate',
                dynamics: 'comp'
            };

            const midiBtn = document.getElementById('midiBtn');
            const midiStatus = document.getElementById('midiStatus');
            const midiMapPreview = document.getElementById('midiMapPreview');
            const masterBypassBtn = document.getElementById('masterBypassBtn');
            const masterBypassLed = document.getElementById('masterBypassLed');
            const midiInputSelect = document.getElementById('midiInputSelect');
            const midiTargetSelect = document.getElementById('midiTargetSelect');
            const midiKeyboardEl = document.getElementById('midiKeyboard');
            const internalKbChannelSelect = document.getElementById('internalKbChannel');
            const deckElements = Array.from(document.querySelectorAll('.sample-browser[data-deck]'));
            let samplerDecks = [];

            // --- 0. Knob Interaction (UI) ---
            // The HTML defines knobs via .knob-container + data-min/data-max/data-value,
            // but there was no JS to make them interactive, so they never changed.
            const KNOB_ANGLE_MIN = -90;  // degrees (12 o'clock-ish)
            const KNOB_ANGLE_MAX = 270;  // degrees (full 360° sweep)

            const knobContainers = Array.from(document.querySelectorAll('.knob-container'));

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

                // Threshold in this UI is 0..100; map to -inf / -60..0dB for display.
                if (p === 'thresh' || p === 'threshold') {
                    if (value <= min) return '-inf';
                    const t = clamp((value - min) / (max - min || 1), 0, 1);
                    const db = -60 + t * 60;
                    return `${db.toFixed(0)}dB`;
                }

                // Anything that looks like a "cut" knob is a % in this mock UI.
                if (p.includes('cut')) return `${Math.round(value)}%`;

                // Default: if 0..100 treat as percent, otherwise show raw.
                if (min === 0 && max === 100) return `${Math.round(value)}%`;
                return String(Math.round(value * 100) / 100);
            }

            function setKnobUI(container, value) {
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
                    // Master knob: the value is the next element sibling (green number)
                    const next = container.nextElementSibling;
                    if (next && next.classList.contains('master-label')) {
                        next.textContent = display;
                    }
                }

                // Notify audio engine (stores state even if audioContext not ready)
                handleKnobChange(param, v);
            }

            // Init knobs (override whatever inline rotate() happens to be)
            knobContainers.forEach((c) => {
                // Make focusable for keyboard tweaks
                if (!c.hasAttribute('tabindex')) c.setAttribute('tabindex', '0');
                setKnobUI(c, toNumber(c.dataset.value, 0));
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

                // Up = increase, Down = decrease
                const dy = dragStartY - e.clientY;

                // Sensitivity: ~150px drag for full range; hold Shift for fine control.
                const pixelsPerFullRange = e.shiftKey ? 750 : 150;
                const delta = (dy / pixelsPerFullRange) * range;

                setKnobUI(c, dragStartValue + delta);
            }

            function onKnobPointerUp(e) {
                const c = e.currentTarget;
                c.classList.remove('active');

                if (activeKnob === c) {
                    activeKnob = null;
                }
                try { c.releasePointerCapture?.(e.pointerId); } catch (_) {}
            }

            function onKnobWheel(e) {
                const c = e.currentTarget;
                const min = toNumber(c.dataset.min, 0);
                const max = toNumber(c.dataset.max, 100);
                const range = (max - min) || 1;

                // Prevent page scroll while adjusting a knob.
                e.preventDefault();

                const step = (e.shiftKey ? range / 500 : range / 200); // fine with Shift
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


            // --- 0b. On-device 5-octave MIDI keyboard ---
            const keyboardConfig = {
                startMidi: 36, // C2
                octaves: 5
            };
            const keyboardKeys = new Map();
            const activeVoices = new Map();
            const pointerNotes = new Map();

            function midiToFreq(note) {
                return 440 * Math.pow(2, (note - 69) / 12);
            }

            function setKeyboardKeyActive(note, active) {
                const key = keyboardKeys.get(note);
                if (!key) return;
                key.classList.toggle('active', active);
            }

            function keyboardNoteOn(note, velocity = 100) {
                if (activeVoices.has(note)) return;

                initAudioContext();
                ensureFxGraph();
                if (!audioContext) return;

                const osc = audioContext.createOscillator();
                const gain = audioContext.createGain();
                const now = audioContext.currentTime;
                const amp = clamp((toNumber(velocity, 100) / 127) * 0.23, 0.02, 0.35);

                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(midiToFreq(note), now);

                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(amp, now + 0.012);

                osc.connect(gain);
                gain.connect((fx && fx.input) ? fx.input : audioContext.destination);
                osc.start(now);

                activeVoices.set(note, { osc, gain });
                setKeyboardKeyActive(note, true);
            }

            function keyboardNoteOff(note) {
                const voice = activeVoices.get(note);
                if (!voice || !audioContext) {
                    setKeyboardKeyActive(note, false);
                    return;
                }

                const now = audioContext.currentTime;
                voice.gain.gain.cancelScheduledValues(now);
                voice.gain.gain.setTargetAtTime(0.0001, now, 0.045);
                try { voice.osc.stop(now + 0.18); } catch (_) {}
                try { voice.osc.disconnect(); } catch (_) {}
                try { voice.gain.disconnect(); } catch (_) {}

                activeVoices.delete(note);
                setKeyboardKeyActive(note, false);
            }

            function buildMidiKeyboard() {
                if (!midiKeyboardEl) return;
                midiKeyboardEl.innerHTML = '';

                const totalNotes = keyboardConfig.octaves * 12;
                const notes = Array.from({ length: totalNotes }, (_, i) => keyboardConfig.startMidi + i);
                const whiteSet = new Set([0, 2, 4, 5, 7, 9, 11]);
                const whiteNotes = notes.filter((n) => whiteSet.has(n % 12));
                const whiteWidth = 100 / whiteNotes.length;

                const whitePositions = new Map();
                whiteNotes.forEach((note, whiteIndex) => {
                    const key = document.createElement('button');
                    key.type = 'button';
                    key.className = 'midi-key white';
                    key.dataset.note = String(note);
                    key.style.left = `${(whiteIndex * whiteWidth).toFixed(4)}%`;
                    key.style.width = `${whiteWidth.toFixed(4)}%`;
                    key.setAttribute('aria-label', `MIDI note ${note}`);
                    midiKeyboardEl.appendChild(key);
                    keyboardKeys.set(note, key);
                    whitePositions.set(note, whiteIndex);
                });

                notes.forEach((note) => {
                    const semitone = note % 12;
                    if (whiteSet.has(semitone)) return;

                    const leftWhite = note - 1;
                    const leftIndex = whitePositions.get(leftWhite);
                    if (leftIndex == null) return;

                    const key = document.createElement('button');
                    key.type = 'button';
                    key.className = 'midi-key black';
                    key.dataset.note = String(note);
                    key.style.left = `${((leftIndex + 0.7) * whiteWidth).toFixed(4)}%`;
                    key.style.width = `${(whiteWidth * 0.6).toFixed(4)}%`;
                    key.setAttribute('aria-label', `MIDI note ${note}`);
                    midiKeyboardEl.appendChild(key);
                    keyboardKeys.set(note, key);
                });

                midiKeyboardEl.querySelectorAll('.midi-key').forEach((key) => {
                    key.addEventListener('pointerdown', (e) => {
                        const note = toNumber(key.dataset.note, -1);
                        if (note < 0) return;
                        const channel = toNumber(internalKbChannelSelect?.value, 3);
                        key.setPointerCapture?.(e.pointerId);
                        pointerNotes.set(e.pointerId, { note, channel });

                        // Internal keyboard is also a sync trigger: start A+B together.
                        startSyncedDecksFromInternal(note, 110);

                        // Keep existing OSC behavior on channel 3 through the main MIDI router.
                        if (channel === 3) {
                            routeMidiMessage(0x90 | ((channel - 1) & 0x0F), note, 110);
                        }
                    });

                    key.addEventListener('pointerup', (e) => {
                        const state = pointerNotes.get(e.pointerId);
                        if (state && state.note != null) {
                            stopSyncedDecksFromInternal(state.note);
                            if ((state.channel || 3) === 3) {
                                routeMidiMessage(0x80 | (((state.channel || 3) - 1) & 0x0F), state.note, 0);
                            }
                        }
                        pointerNotes.delete(e.pointerId);
                    });

                    key.addEventListener('pointercancel', (e) => {
                        const state = pointerNotes.get(e.pointerId);
                        if (state && state.note != null) {
                            stopSyncedDecksFromInternal(state.note);
                            if ((state.channel || 3) === 3) {
                                routeMidiMessage(0x80 | (((state.channel || 3) - 1) & 0x0F), state.note, 0);
                            }
                        }
                        pointerNotes.delete(e.pointerId);
                    });

                    key.addEventListener('contextmenu', (e) => e.preventDefault());
                });
            }

            buildMidiKeyboard();

            // --- 0c. MIDI + USB class-compliant support (Launchkey / Ableton Move style) ---
            let midiAccess = null;
            const midiInputs = new Map();
            const midiConfig = {
                rootNote: 60,
                isEnabled: false,
                selectedInputId: 'all',
                targetMode: 'ALL',
                ccMap: {
                    20: 'Drive',
                    21: 'Tone',
                    22: 'Level',
                    23: 'Size',
                    24: 'Diff',
                    25: 'Mod',
                    26: 'Decay',
                    27: 'Low Cut',
                    28: 'High Cut',
                    29: 'Thresh',
                    30: 'Ratio',
                    31: 'Gain',
                    32: 'Master'
                }
            };

            function updateMidiStatus(text, isError = false) {
                if (!midiStatus) return;
                midiStatus.textContent = text;
                midiStatus.style.color = isError ? 'var(--accent-red)' : 'var(--text-muted)';
            }

            function setupMidiMapPreview() {
                if (!midiMapPreview) return;
                const entries = Object.entries(midiConfig.ccMap)
                    .map(([cc, param]) => `CC${cc}:${param}`)
                    .join(' · ');
                midiMapPreview.textContent = `${entries} · Ch1=A · Ch2=B · Ch3=OSC · Note On/Off routes by channel · CC120/123 panic`;
                midiMapPreview.title = 'MIDI channel routing: 1->A deck, 2->B deck, 3->oscillator keyboard engine';
            }

            function setParamFromMidi(param, ccValue) {
                const target = knobContainers.find((k) => k.dataset.param === param);
                if (!target) return;

                const min = toNumber(target.dataset.min, 0);
                const max = toNumber(target.dataset.max, 100);
                const norm = clamp(toNumber(ccValue, 0) / 127, 0, 1);
                const nextValue = min + ((max - min) * norm);
                setKnobUI(target, nextValue);
            }

            function targetFromChannel(channel) {
                if (channel === 1) return 'A';
                if (channel === 2) return 'B';
                if (channel === 3) return 'OSC';
                return null;
            }

            function resolveMidiTarget(channel) {
                if (midiConfig.targetMode === 'ALL') {
                    return targetFromChannel(channel);
                }
                const forced = Number(midiConfig.targetMode);
                return channel === forced ? targetFromChannel(forced) : null;
            }

            function panicAllMidiNotes() {
                samplerDecks.forEach((deck) => deck?.panicMidiNotes?.());
                for (const note of Array.from(activeVoices.keys())) {
                    keyboardNoteOff(note);
                }
                updateMidiStatus('MIDI panic: all notes stopped');
            }

            function applyInputRouting() {
                midiInputs.forEach((input) => {
                    if (!input) return;
                    const shouldListen = midiConfig.isEnabled && (midiConfig.selectedInputId === 'all' || midiConfig.selectedInputId === input.id);
                    input.onmidimessage = shouldListen ? onMIDIMessage : null;
                });
            }

            function populateMidiInputSelect() {
                if (!midiInputSelect) return;
                midiInputSelect.innerHTML = '';

                const allOpt = document.createElement('option');
                allOpt.value = 'all';
                allOpt.textContent = 'All inputs';
                midiInputSelect.appendChild(allOpt);

                midiInputs.forEach((input) => {
                    const opt = document.createElement('option');
                    opt.value = input.id;
                    opt.textContent = input.name || 'Unnamed USB MIDI';
                    midiInputSelect.appendChild(opt);
                });

                const hasSelected = Array.from(midiInputSelect.options).some((o) => o.value === midiConfig.selectedInputId);
                if (!hasSelected) midiConfig.selectedInputId = 'all';
                midiInputSelect.value = midiConfig.selectedInputId;
                midiInputSelect.disabled = !midiConfig.isEnabled;
            }

            function routeMidiMessage(status, data1, data2 = 0) {
                const type = status & 0xF0;
                const channel = (status & 0x0F) + 1;
                const target = resolveMidiTarget(channel);

                if (type === 0xB0) {
                    if (data1 === 120 || data1 === 123) {
                        panicAllMidiNotes();
                        return;
                    }

                    // Keep CC mapping consistent: apply only from Ch1, or from forced Ch1 selection.
                    const ccAccepted = (midiConfig.targetMode === 'ALL' && channel === 1)
                        || (midiConfig.targetMode === '1' && channel === 1);
                    if (!ccAccepted) return;

                    const param = midiConfig.ccMap[data1];
                    if (param) {
                        setParamFromMidi(param, data2);
                        updateMidiStatus(`MIDI Ch${channel}: CC${data1} -> ${param} (${data2})`);
                    }
                    return;
                }

                if (!target) return;

                if (type === 0x90 && data2 > 0) {
                    if (target === 'A') samplerDecks[0]?.triggerMidiNote?.(data1, data2, midiConfig.rootNote);
                    if (target === 'B') samplerDecks[1]?.triggerMidiNote?.(data1, data2, midiConfig.rootNote);
                    if (target === 'OSC') keyboardNoteOn(data1, data2);
                    updateMidiStatus(`MIDI Ch${channel}: NoteOn ${data1} vel ${data2} -> ${target}`);
                    return;
                }

                if (type === 0x80 || (type === 0x90 && data2 === 0)) {
                    if (target === 'A') samplerDecks[0]?.releaseMidiNote?.(data1);
                    if (target === 'B') samplerDecks[1]?.releaseMidiNote?.(data1);
                    if (target === 'OSC') keyboardNoteOff(data1);
                    updateMidiStatus(`MIDI Ch${channel}: NoteOff ${data1} -> ${target}`);
                }
            }

            function onMIDIMessage(event) {
                const [status, data1, data2] = event.data;
                routeMidiMessage(status, data1, data2);
            }

            function refreshMidiInputs() {
                if (!midiAccess) return;
                midiInputs.clear();
                midiAccess.inputs.forEach((input) => {
                    midiInputs.set(input.id, input);
                });

                populateMidiInputSelect();
                applyInputRouting();

                if (midiInputs.size > 0) {
                    const names = Array.from(midiInputs.values()).map((i) => i.name || 'Unnamed USB MIDI').join(', ');
                    updateMidiStatus(midiConfig.isEnabled ? `MIDI On: ${names}` : `MIDI ready: ${names}`);
                } else {
                    updateMidiStatus(midiConfig.isEnabled ? 'MIDI On. Connect a USB-C/USB MIDI controller.' : 'MIDI Off');
                }
            }

            async function setMidiEnabled(enabled) {
                if (enabled) {
                    if (!navigator.requestMIDIAccess) {
                        updateMidiStatus('Web MIDI not supported in this browser.', true);
                        return;
                    }
                    try {
                        if (!midiAccess) {
                            midiAccess = await navigator.requestMIDIAccess({ sysex: false });
                            midiAccess.onstatechange = refreshMidiInputs;
                        }
                        midiConfig.isEnabled = true;
                        if (midiBtn) midiBtn.textContent = 'MIDI OFF';
                        refreshMidiInputs();
                    } catch (err) {
                        updateMidiStatus('MIDI permission denied or unavailable.', true);
                    }
                    return;
                }

                midiConfig.isEnabled = false;
                applyInputRouting();
                panicAllMidiNotes();
                if (midiBtn) midiBtn.textContent = 'MIDI ON';
                if (midiInputSelect) midiInputSelect.disabled = true;
                updateMidiStatus('MIDI: Off');
            }

            if (midiBtn) {
                midiBtn.addEventListener('click', () => setMidiEnabled(!midiConfig.isEnabled));
            }
            if (midiInputSelect) {
                midiInputSelect.addEventListener('change', (e) => {
                    midiConfig.selectedInputId = e.target.value || 'all';
                    applyInputRouting();
                    updateMidiStatus(`MIDI input: ${midiConfig.selectedInputId === 'all' ? 'All inputs' : (midiInputs.get(midiConfig.selectedInputId)?.name || 'Unknown')}`);
                });
            }
            if (midiTargetSelect) {
                midiTargetSelect.value = midiConfig.targetMode;
                midiTargetSelect.addEventListener('change', (e) => {
                    midiConfig.targetMode = e.target.value || 'ALL';
                    updateMidiStatus(`MIDI channel filter: ${midiConfig.targetMode}`);
                });
            }

            populateMidiInputSelect();
            setupMidiMapPreview();

            function applyMasterBypassVisualState() {
                if (masterBypassBtn) {
                    masterBypassBtn.classList.toggle('active', isMasterBypassed);
                    masterBypassBtn.textContent = isMasterBypassed ? 'BYPASSED' : 'FX ON';
                    masterBypassBtn.setAttribute('aria-pressed', String(isMasterBypassed));
                }
                if (masterBypassLed) {
                    masterBypassLed.classList.toggle('on', !isMasterBypassed);
                }
                document.querySelectorAll('.workspace .module .module-header .led').forEach((led) => {
                    led.classList.toggle('on', !isMasterBypassed);
                });
            }

            function applyMasterBypassAudioState() {
                if (!audioContext || !fx) return;
                const t = audioContext.currentTime;
                const n = fx.nodes;
                // FX path bypass for all five modules; master volume remains active.
                n.fxPathGain.gain.setTargetAtTime(isMasterBypassed ? 0 : 1, t, 0.01);
                n.cleanBypassGain.gain.setTargetAtTime(isMasterBypassed ? 1 : 0, t, 0.01);
            }

            function setMasterBypass(nextState) {
                isMasterBypassed = !!nextState;
                applyMasterBypassVisualState();
                applyMasterBypassAudioState();
            }

            if (masterBypassBtn) {
                masterBypassBtn.addEventListener('click', () => setMasterBypass(!isMasterBypassed));
            }
            applyMasterBypassVisualState();

            // --- Helper: Init Audio Context ---
            const initAudioContext = () => {
                if (!audioContext) {
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                if (audioContext.state === 'suspended') {
                    audioContext.resume();
                }
            };

            // --- FX Graph (WebAudio) ---
            // Build once, then update node params as knobs change.
            function ensureFxGraph() {
                if (!audioContext) return null;
                if (fx) return fx;

                // Core nodes
                const input = audioContext.createGain();
                const fxPathGain = audioContext.createGain();
                const cleanBypassGain = audioContext.createGain();

                // Distortion stage
                const driveGain = audioContext.createGain();
                const shaper = audioContext.createWaveShaper();
                shaper.oversample = '4x';
                const toneFilter = audioContext.createBiquadFilter();
                toneFilter.type = 'lowpass';
                const distLevel = audioContext.createGain();

                // Delay stage
                const delayNode = audioContext.createDelay(1.2);
                delayNode.delayTime.value = 0.24;
                const delayFeedback = audioContext.createGain();
                delayFeedback.gain.value = 0.35;
                const delayFilter = audioContext.createBiquadFilter();
                delayFilter.type = 'lowpass';
                delayFilter.frequency.value = 6800;
                const delayWet = audioContext.createGain();
                delayWet.gain.value = 0.18;

                // Reverb stage (with predelay + optional modulation)
                const preVerbSendGain = audioContext.createGain();
                const preDelay = audioContext.createDelay(0.2); // up to 200ms
                const modDelay = audioContext.createDelay(0.05); // subtle modulation
                const modDepth = audioContext.createGain(); // scales LFO
                const lfo = audioContext.createOscillator();
                const lfoGain = audioContext.createGain();
                lfo.type = 'sine';
                lfo.frequency.value = 0.8; // updated by Mod knob
                lfoGain.gain.value = 0.0;  // updated by Mod knob
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

                // Wet/Dry mix (no dedicated knob in UI; we derive from Size)
                const dryGain = audioContext.createGain();
                const wetGain = audioContext.createGain();

                // Dynamics + output
                const compressor = audioContext.createDynamicsCompressor();
                compressor.knee.value = 24;
                compressor.attack.value = 0.006;
                compressor.release.value = 0.18;

                const makeupGain = audioContext.createGain();
                const masterGain = audioContext.createGain();

                // Wire it up:
                // input -> (fx path + clean bypass)
                input.connect(fxPathGain);
                input.connect(cleanBypassGain);

                // fx path -> drive -> shaper -> tone -> level -> split dry + wet
                fxPathGain.connect(driveGain);
                driveGain.connect(shaper);
                shaper.connect(toneFilter);
                toneFilter.connect(distLevel);

                // dry path
                distLevel.connect(dryGain);

                // delay path
                distLevel.connect(delayNode);
                delayNode.connect(delayFilter);
                delayFilter.connect(delayWet);
                delayFilter.connect(delayFeedback);
                delayFeedback.connect(delayNode);

                // wet path: predelay -> modDelay -> convolver -> EQ -> wetGain
                distLevel.connect(preVerbSendGain);
                preVerbSendGain.connect(preDelay);
                preDelay.connect(modDelay);
                modDelay.connect(convolver);
                convolver.connect(lowCut);
                lowCut.connect(highCut);
                highCut.connect(wetGain);

                // sum -> compressor -> makeup -> master -> destination
                const sum = audioContext.createGain();
                dryGain.connect(sum);
                wetGain.connect(sum);
                delayWet.connect(sum);

                sum.connect(compressor);
                compressor.connect(makeupGain);
                makeupGain.connect(masterGain);
                cleanBypassGain.connect(masterGain);
                masterGain.connect(audioContext.destination);

                fx = {
                    input,
                    output: masterGain,
                    nodes: {
                        fxPathGain, cleanBypassGain,
                        driveGain, shaper, toneFilter, distLevel,
                        delayNode, delayFeedback, delayFilter, delayWet,
                        preVerbSendGain, preDelay, modDelay, modDepth, lfo, lfoGain,
                        convolver, lowCut, highCut,
                        dryGain, wetGain,
                        compressor, makeupGain, masterGain,
                        sum
                    }
                };

                // Initialize node params from current knob positions
                applyAllKnobsToAudio();
                applyModuleModesToAudio();
                applyMasterBypassAudioState();

                // Build initial impulse response
                scheduleReverbRegen(true);

                return fx;
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

            function logReverbSanityOnce() {
                if (hasLoggedReverbSanity || !audioContext || !fx) return;
                hasLoggedReverbSanity = true;
                const n = fx.nodes;
                console.info('[Reverb sanity]', {
                    nodeExists: !!n.convolver,
                    mode: moduleModeState.reverb,
                    wet: Number.isFinite(n.wetGain?.gain?.value) ? Number(n.wetGain.gain.value.toFixed(3)) : null,
                    bufferSet: !!n.convolver?.buffer
                });
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

            function regenReverbNow() {
                if (!audioContext || !fx) return;

                // Read knobs (fallback defaults)
                const size = toNumber(knobState['Size'] ?? 30, 30);      // 0..100
                const decay = toNumber(knobState['Decay'] ?? 85, 85);    // 0..100
                const diff = toNumber(knobState['Diff'] ?? 75, 75);      // 0..100

                // Map to IR length in seconds
                const sizeNorm = clamp(size / 100, 0, 1);
                const decayNorm = clamp(decay / 100, 0, 1);
                const diffNorm = clamp(diff / 100, 0, 1);

                const preverbMode = moduleModeState.preverb;
                const reverbMode = moduleModeState.reverb;

                // IR length/mood changes by mode.
                let seconds = clamp(0.35 + sizeNorm * 1.1 + decayNorm * 7.0, 0.35, 10.0);
                let diffusion = diffNorm;

                if (preverbMode === 'kill') {
                    seconds = clamp(seconds * 0.58, 0.25, 5.0);
                    diffusion = clamp(diffusion * 0.72, 0, 1);
                }
                if (preverbMode === 'freeze') {
                    seconds = 12.0;
                    diffusion = 0.98;
                }
                if (reverbMode === 'plate') {
                    seconds = clamp(seconds * 0.78, 0.35, 8.0);
                    diffusion = clamp(diffusion * 0.85, 0, 1);
                }

                const ir = createImpulseResponse(audioContext, { seconds, diffusion });
                fx.nodes.convolver.buffer = ir;
                logReverbSanityOnce();
            }

            function applyAllKnobsToAudio() {
                // Apply every current knob value (if any) to audio nodes.
                if (!audioContext) return;
                ensureFxGraph();
                Object.keys(knobState).forEach((p) => applyKnobToAudio(p, knobState[p]));
                applyModuleModesToAudio();
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
                        const crunch = moduleModeState.distortion === 'crunch';
                        const driveScale = crunch ? 10 : 19;
                        const curveAmt = crunch ? norm * 0.55 : norm;
                        n.driveGain.gain.setTargetAtTime(1 + curveAmt * driveScale, t, 0.01);
                        n.shaper.curve = makeDistortionCurve(curveAmt);
                        break;
                    }
                    case 'Tone': {
                        const norm = clamp(v / 100, 0, 1);
                        // 500..12000 Hz
                        const cutoff = 500 * Math.pow(24, norm); // ~500..12000
                        n.toneFilter.frequency.setTargetAtTime(cutoff, t, 0.01);
                        n.toneFilter.Q.setTargetAtTime(0.5 + norm * 1.5, t, 0.01);
                        break;
                    }
                    case 'Level': {
                        const norm = clamp(v / 100, 0, 1);
                        // 0..1.6
                        n.distLevel.gain.setTargetAtTime(norm * 1.6, t, 0.01);
                        break;
                    }

                    // --- Delay ---
                    case 'Time': {
                        const norm = clamp(v / 100, 0, 1);
                        const dt = 0.03 + norm * 0.87; // 30ms..900ms
                        n.delayNode.delayTime.setTargetAtTime(dt, t, 0.02);
                        break;
                    }
                    case 'Feedback': {
                        const norm = clamp(v / 100, 0, 1);
                        const isTape = moduleModeState.delay === 'tape';
                        n.delayFeedback.gain.setTargetAtTime(norm * (isTape ? 0.75 : 0.92), t, 0.02);
                        break;
                    }
                    case 'Mix': {
                        const norm = clamp(v / 100, 0, 1);
                        const isTape = moduleModeState.delay === 'tape';
                        n.delayWet.gain.setTargetAtTime(norm * (isTape ? 0.62 : 0.8), t, 0.02);
                        break;
                    }

                    // --- Reverb ---
                    case 'Size': {
                        const norm = clamp(v / 100, 0, 1);
                        const reverbMode = moduleModeState.reverb;
                        const preverbMode = moduleModeState.preverb;
                        const reverbEnabled = getModuleEnabled('Reverb');

                        // Hall has longer predelay and larger image; plate is tighter/earlier.
                        const preDelaySeconds = reverbMode === 'plate'
                            ? (0.004 + norm * 0.016)
                            : (0.012 + norm * 0.048);
                        n.preDelay.delayTime.setTargetAtTime(preDelaySeconds, t, 0.015);

                        let wet = reverbMode === 'plate'
                            ? clamp(0.08 + norm * 0.50, 0.08, 0.70)
                            : clamp(0.14 + norm * 0.72, 0.14, 0.92);
                        let dry = clamp(1.0 - wet * 0.60, 0.20, 1.0);

                        if (preverbMode === 'kill') {
                            wet = clamp(wet * 0.45, 0.06, 0.40);
                            dry = clamp(1.0 - wet * 0.30, 0.72, 1.0);
                        }
                        if (preverbMode === 'freeze') {
                            wet = Math.max(wet, 0.92);
                            dry = Math.min(dry, 0.22);
                        }
                        if (!reverbEnabled) {
                            wet = 0;
                            dry = 1;
                        }

                        n.wetGain.gain.setTargetAtTime(wet, t, 0.03);
                        n.dryGain.gain.setTargetAtTime(dry, t, 0.03);
                        scheduleReverbRegen();
                        break;
                    }
                    case 'Diff': {
                        scheduleReverbRegen();
                        break;
                    }
                    case 'Decay': {
                        scheduleReverbRegen();
                        break;
                    }
                    case 'Mod': {
                        const norm = clamp(v / 100, 0, 1);
                        // LFO rate 0.2..2.2 Hz, depth 0..8ms
                        const rate = 0.2 + norm * 2.0;
                        const depth = moduleModeState.preverb === 'freeze' ? Math.max(norm * 0.008, 0.004) : norm * 0.008; // seconds
                        n.lfo.frequency.setTargetAtTime(rate, t, 0.02);
                        n.lfoGain.gain.setTargetAtTime(1.0, t, 0.02);
                        // Base delay follows a bit of size, but keep subtle
                        n.modDelay.delayTime.setTargetAtTime(0.010, t, 0.02);
                        n.modDepth.gain.setTargetAtTime(depth, t, 0.02);
                        break;
                    }
                    case 'Low Cut': {
                        // 20..800 Hz
                        const norm = clamp(v / 100, 0, 1);
                        const fc = 20 * Math.pow(40, norm); // ~20..800
                        n.lowCut.frequency.setTargetAtTime(fc, t, 0.02);
                        n.lowCut.Q.setTargetAtTime(0.7, t, 0.02);
                        break;
                    }
                    case 'High Cut': {
                        // 1000..16000 Hz
                        const norm = clamp(v / 100, 0, 1);
                        let fc = 16000 * Math.pow(0.0625, 1 - norm); // ~1000..16000
                        if (moduleModeState.reverb === 'plate') fc *= 0.72;
                        n.highCut.frequency.setTargetAtTime(fc, t, 0.02);
                        n.highCut.Q.setTargetAtTime(0.7, t, 0.02);
                        break;
                    }

                    // --- Dynamics ---
                    case 'Thresh': {
                        // knob 0..100 => -60..0 dB
                        const thr = -60 + (clamp(v / 100, 0, 1) * 60);
                        n.compressor.threshold.setTargetAtTime(thr, t, 0.02);
                        break;
                    }
                    case 'Ratio': {
                        // knob min 1 max 20 => 1..20
                        const lim = moduleModeState.dynamics === 'limiter';
                        n.compressor.ratio.setTargetAtTime(lim ? clamp(10 + v * 2, 12, 20) : clamp(v, 1, 20), t, 0.02);
                        break;
                    }
                    case 'Gain': {
                        // knob 0..24 => 0..24 dB makeup
                        const g = dbToGain(clamp(v, 0, 24));
                        n.makeupGain.gain.setTargetAtTime(g, t, 0.02);
                        break;
                    }

                    // --- Master ---
                    case 'Master': {
                        const norm = clamp(v / 100, 0, 1);
                        // 0..1.0 with a gentle taper
                        n.masterGain.gain.setTargetAtTime(Math.pow(norm, 1.6), t, 0.02);
                        break;
                    }
                }
            }

            function handleKnobChange(param, value) {
                if (!param) return;
                knobState[param] = toNumber(value, 0);

                // If audio is ready, apply immediately
                if (!audioContext) return;
                ensureFxGraph();
                applyKnobToAudio(param, knobState[param]);
            }

            function getModuleEnabled(moduleName) {
                const modules = Array.from(document.querySelectorAll('.workspace .module'));
                const target = modules.find((m) => {
                    const label = m.querySelector('.module-header span');
                    return (label?.textContent || '').trim().toLowerCase() === String(moduleName).toLowerCase();
                });
                if (!target) return true;
                const led = target.querySelector('.module-header .led');
                return led ? led.classList.contains('on') : true;
            }

            function getKnobValue(param, fallback = 0) {
                return toNumber(knobState[param], fallback);
            }

            function softSwitchDistortionMode() {
                if (!audioContext || !fx) return;
                const n = fx.nodes;
                const now = audioContext.currentTime;
                const currentLevel = clamp(getKnobValue('Level', 80) / 100, 0, 1) * 1.6;

                // tiny dip to reduce clicks when changing waveshaper curve
                n.distLevel.gain.cancelScheduledValues(now);
                n.distLevel.gain.setValueAtTime(n.distLevel.gain.value, now);
                n.distLevel.gain.linearRampToValueAtTime(currentLevel * 0.85, now + 0.012);
                applyKnobToAudio('Drive', getKnobValue('Drive', 65));
                n.distLevel.gain.linearRampToValueAtTime(currentLevel, now + 0.04);
            }

            function applyModuleModesToAudio() {
                if (!audioContext || !fx) return;
                const t = audioContext.currentTime;
                const n = fx.nodes;

                const preverbMode = moduleModeState.preverb;
                n.preVerbSendGain.gain.setTargetAtTime(preverbMode === 'kill' ? 0.42 : (preverbMode === 'freeze' ? 1.25 : 1), t, 0.02);
                n.modDepth.gain.setTargetAtTime(preverbMode === 'freeze' ? Math.max(n.modDepth.gain.value, 0.004) : n.modDepth.gain.value, t, 0.02);

                const tape = moduleModeState.delay === 'tape';
                n.delayFilter.frequency.setTargetAtTime(tape ? 2400 : 6800, t, 0.03);

                const lim = moduleModeState.dynamics === 'limiter';
                n.compressor.attack.setTargetAtTime(lim ? 0.001 : 0.006, t, 0.02);
                n.compressor.release.setTargetAtTime(lim ? 0.08 : 0.18, t, 0.02);
                n.compressor.knee.setTargetAtTime(lim ? 3 : 24, t, 0.02);

                const plate = moduleModeState.reverb === 'plate';
                n.preDelay.delayTime.setTargetAtTime(plate ? 0.008 : 0.024, t, 0.03);
                n.lowCut.frequency.setTargetAtTime(plate ? 120 : 70, t, 0.03);
                n.highCut.frequency.setTargetAtTime(plate ? 7600 : 10500, t, 0.03);

                applyKnobToAudio('Size', getKnobValue('Size', 30));
                scheduleReverbRegen();
            }

            function initModuleModeButtons() {
                const mapping = {
                    distortion: ['fuzz', 'crunch'],
                    preverb: ['kill', 'freeze'],
                    delay: ['digital', 'tape'],
                    reverb: ['hall', 'plate'],
                    dynamics: ['comp', 'limiter']
                };

                document.querySelectorAll('.workspace .module').forEach((moduleEl) => {
                    const header = moduleEl.querySelector('.module-header span');
                    const modeRow = moduleEl.querySelector('.btn-row');
                    if (!header || !modeRow) return;
                    const moduleName = header.textContent.trim().toLowerCase().replace(/[-\s]+/g, '');
                    const modes = mapping[moduleName];
                    if (!modes) return;

                    const buttons = Array.from(modeRow.querySelectorAll('.btn'));
                    buttons.forEach((btn, idx) => {
                        const mode = modes[idx] || btn.textContent.trim().toLowerCase();
                        btn.dataset.mode = mode;
                        const isActive = moduleModeState[moduleName] === mode;
                        btn.classList.toggle('active', isActive);
                        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');

                        btn.addEventListener('click', () => {
                            if (moduleModeState[moduleName] === mode) return;
                            moduleModeState[moduleName] = mode;
                            buttons.forEach((b) => {
                                const selected = b.dataset.mode === mode;
                                b.classList.toggle('active', selected);
                                b.setAttribute('aria-pressed', selected ? 'true' : 'false');
                            });

                            if (audioContext) {
                                ensureFxGraph();
                                if (moduleName === 'distortion') softSwitchDistortionMode();
                                applyModuleModesToAudio();
                                applyAllKnobsToAudio();
                            }
                        });
                    });
                });
            }

            initModuleModeButtons();

            // --- 1. Dual Sampler Decks (A/B) ---
            function createProceduralBuffer() {
                if (!audioContext) return null;
                const sampleRate = audioContext.sampleRate;
                const frameCount = Math.floor(sampleRate * 2.0);
                const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < frameCount; i++) {
                    data[i] = (Math.random() * 2 - 1) * Math.exp(-3 * i / frameCount);
                }
                return buffer;
            }

            function createSamplerDeck(root, index) {
                const canvas = root.querySelector('[data-role="waveform"]');
                const ctx = canvas?.getContext('2d');
                const playBtn = root.querySelector('[data-role="play"]');
                const stopBtn = root.querySelector('[data-role="stop"]');
                const loopBtn = root.querySelector('[data-role="loop"]');
                const importBtn = root.querySelector('[data-role="import"]');
                const exportBtn = root.querySelector('[data-role="export"]');
                const muteBtn = root.querySelector('[data-role="mute"]');
                const fileInput = root.querySelector('[data-role="audio-input"]');
                const sampleList = root.querySelector('[data-role="sample-list"]');
                const volumeSlider = root.querySelector('[data-role="deck-volume"]');
                const volumeValue = root.querySelector('[data-role="deck-volume-value"]');

                const deck = {
                    index,
                    name: root.dataset.deck || String(index + 1),
                    root,
                    canvas,
                    ctx,
                    playBtn,
                    stopBtn,
                    loopBtn,
                    importBtn,
                    exportBtn,
                    muteBtn,
                    fileInput,
                    sampleList,
                    volumeSlider,
                    volumeValue,
                    currentBuffer: null,
                    sampleGain: null,
                    level: 0.8,
                    muted: false,
                    sourceNode: null,
                    activeMidiVoices: new Map(),
                    isPlaying: false,
                    isLooping: false,
                    regionStart: 0,
                    regionEnd: 1,
                    isDraggingStart: false,
                    isDraggingEnd: false
                };

                function updateLoopButtonUI() {
                    if (!deck.loopBtn) return;
                    deck.loopBtn.classList.toggle('looping', deck.isLooping);
                    deck.loopBtn.setAttribute('aria-pressed', String(deck.isLooping));
                    deck.loopBtn.title = deck.isLooping ? 'Loop: On' : 'Loop: Off';
                }

                function getDeckOutputGain() {
                    return deck.muted ? 0 : deck.level;
                }

                function ensureDeckGain() {
                    if (!audioContext || !fx) return null;
                    if (!deck.sampleGain) {
                        deck.sampleGain = audioContext.createGain();
                        deck.sampleGain.connect(fx.input);
                    }
                    deck.sampleGain.gain.setTargetAtTime(getDeckOutputGain(), audioContext.currentTime, 0.01);
                    return deck.sampleGain;
                }

                function updateDeckMuteUI() {
                    if (!deck.muteBtn) return;
                    deck.muteBtn.classList.toggle('active', deck.muted);
                    deck.muteBtn.textContent = `${deck.muted ? 'Unmute' : 'Mute'} ${deck.name}`;
                }

                function setDeckMuted(isMuted) {
                    deck.muted = !!isMuted;
                    updateDeckMuteUI();
                    if (audioContext && deck.sampleGain) {
                        deck.sampleGain.gain.setTargetAtTime(getDeckOutputGain(), audioContext.currentTime, 0.01);
                    }
                }

                function updateDeckVolume(value) {
                    const norm = clamp(toNumber(value, 100) / 100, 0, 1);
                    deck.level = norm;
                    if (deck.volumeSlider) deck.volumeSlider.value = String(Math.round(norm * 100));
                    if (deck.volumeValue) deck.volumeValue.textContent = String(Math.round(norm * 100));
                    if (audioContext && deck.sampleGain) {
                        deck.sampleGain.gain.setTargetAtTime(getDeckOutputGain(), audioContext.currentTime, 0.02);
                    }
                }

                function updateSourceLoopingFromRegion() {
                    if (!deck.sourceNode || !deck.currentBuffer) return;
                    const duration = deck.currentBuffer.duration * (deck.regionEnd - deck.regionStart);
                    const offset = deck.currentBuffer.duration * deck.regionStart;
                    deck.sourceNode.loop = deck.isLooping;
                    if (deck.isLooping) {
                        deck.sourceNode.loopStart = offset;
                        deck.sourceNode.loopEnd = offset + duration;
                    }
                }

                function resetRegion() {
                    deck.regionStart = 0;
                    deck.regionEnd = 1;
                }

                function drawWaveform() {
                    if (!deck.canvas || !deck.ctx) return;
                    const dpr = window.devicePixelRatio || 1;
                    const rect = deck.canvas.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return;

                    deck.canvas.width = rect.width * dpr;
                    deck.canvas.height = rect.height * dpr;
                    deck.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

                    const width = rect.width;
                    const height = rect.height;
                    const centerY = height / 2;
                    deck.ctx.clearRect(0, 0, width, height);

                    if (!deck.currentBuffer) return;

                    const data = deck.currentBuffer.getChannelData(0);
                    const step = Math.max(1, Math.ceil(data.length / width));
                    const amp = height / 2;

                    const startX = Math.floor(deck.regionStart * width);
                    const endX = Math.floor(deck.regionEnd * width);

                    deck.ctx.fillStyle = '#2a3a2a';
                    for (let i = 0; i < width; i += 2) {
                        let min = 1.0;
                        let max = -1.0;
                        for (let j = 0; j < step; j++) {
                            const datum = data[(i * step) + j] || 0;
                            if (datum < min) min = datum;
                            if (datum > max) max = datum;
                        }
                        const barHeight = (max - min) * amp;
                        const y = centerY - (barHeight / 2);
                        deck.ctx.fillRect(i, y, 1.5, barHeight);
                    }

                    deck.ctx.fillStyle = '#4ade80';
                    for (let i = startX; i < endX; i += 2) {
                        let min = 1.0;
                        let max = -1.0;
                        for (let j = 0; j < step; j++) {
                            const datum = data[(i * step) + j] || 0;
                            if (datum < min) min = datum;
                            if (datum > max) max = datum;
                        }
                        const barHeight = (max - min) * amp;
                        const y = centerY - (barHeight / 2);
                        deck.ctx.fillRect(i, y, 1.5, barHeight);
                    }

                    deck.ctx.fillStyle = '#fff';
                    deck.ctx.beginPath();
                    deck.ctx.moveTo(startX, 0);
                    deck.ctx.lineTo(startX - 6, 8);
                    deck.ctx.lineTo(startX + 6, 8);
                    deck.ctx.fill();
                    deck.ctx.fillRect(startX - 1, 8, 2, height - 16);

                    deck.ctx.beginPath();
                    deck.ctx.moveTo(endX, height);
                    deck.ctx.lineTo(endX - 6, height - 8);
                    deck.ctx.lineTo(endX + 6, height - 8);
                    deck.ctx.fill();
                    deck.ctx.fillRect(endX - 1, 8, 2, height - 16);
                }

                function handleHit(x) {
                    const width = deck.canvas.width / (window.devicePixelRatio || 1);
                    const startX = deck.regionStart * width;
                    const endX = deck.regionEnd * width;
                    const threshold = 10;
                    if (Math.abs(x - startX) < threshold) return 'start';
                    if (Math.abs(x - endX) < threshold) return 'end';
                    return null;
                }

                function stopSample() {
                    if (deck.sourceNode) {
                        try { deck.sourceNode.stop(); } catch (e) {}
                        try { deck.sourceNode.disconnect(); } catch (e) {}
                        deck.sourceNode = null;
                    }
                    deck.isPlaying = false;
                    deck.playBtn?.classList.remove('playing');
                }

                function playSample() {
                    initAudioContext();
                    ensureFxGraph();

                    if (!deck.currentBuffer && !deck.isPlaying) {
                        deck.currentBuffer = createProceduralBuffer();
                        resetRegion();
                        drawWaveform();
                    }
                    if (!deck.currentBuffer) return;

                    stopSample();

                    deck.sourceNode = audioContext.createBufferSource();
                    deck.sourceNode.buffer = deck.currentBuffer;
                    const deckGain = ensureDeckGain();
                    if (!deckGain) return;
                    deck.sourceNode.connect(deckGain);

                    const duration = deck.currentBuffer.duration * (deck.regionEnd - deck.regionStart);
                    const offset = deck.currentBuffer.duration * deck.regionStart;

                    deck.sourceNode.loop = deck.isLooping;
                    if (deck.isLooping) {
                        deck.sourceNode.loopStart = offset;
                        deck.sourceNode.loopEnd = offset + duration;
                        deck.sourceNode.start(0, offset);
                    } else {
                        deck.sourceNode.start(0, offset, duration);
                    }

                    deck.isPlaying = true;
                    deck.playBtn?.classList.add('playing');

                    if (!deck.isLooping) {
                        deck.sourceNode.onended = () => {
                            deck.isPlaying = false;
                            deck.playBtn?.classList.remove('playing');
                        };
                    }
                }

                function triggerMidiNote(note, velocity = 127, rootNote = 60, options = {}) {
                    initAudioContext();
                    ensureFxGraph();

                    if (!deck.currentBuffer) {
                        deck.currentBuffer = createProceduralBuffer();
                        resetRegion();
                        drawWaveform();
                    }
                    if (!deck.currentBuffer) return;

                    releaseMidiNote(note);

                    const deckGain = ensureDeckGain();
                    if (!deckGain || !audioContext) return;

                    const velocityNorm = clamp(toNumber(velocity, 127) / 127, 0, 1);
                    const voiceGain = audioContext.createGain();
                    const src = audioContext.createBufferSource();
                    src.buffer = deck.currentBuffer;
                    src.playbackRate.value = Math.pow(2, (toNumber(note, 60) - toNumber(rootNote, 60)) / 12);

                    const duration = deck.currentBuffer.duration * (deck.regionEnd - deck.regionStart);
                    const offset = deck.currentBuffer.duration * deck.regionStart;
                    voiceGain.gain.setValueAtTime(velocityNorm, audioContext.currentTime);

                    src.connect(voiceGain);
                    voiceGain.connect(deckGain);

                    src.loop = true;
                    src.loopStart = offset;
                    src.loopEnd = offset + duration;
                    const startAt = Number.isFinite(options.startTime) ? options.startTime : 0;
                    src.start(startAt, offset);

                    const voices = deck.activeMidiVoices.get(note) || [];
                    const voice = { src, voiceGain };
                    voices.push(voice);
                    deck.activeMidiVoices.set(note, voices);

                    src.onended = () => {
                        const current = deck.activeMidiVoices.get(note) || [];
                        const next = current.filter((v) => v !== voice);
                        if (next.length) deck.activeMidiVoices.set(note, next);
                        else deck.activeMidiVoices.delete(note);
                    };
                }

                function releaseMidiNote(note) {
                    const voices = deck.activeMidiVoices.get(note);
                    if (!voices || !audioContext) return;
                    const now = audioContext.currentTime;
                    voices.forEach(({ src, voiceGain }) => {
                        try {
                            voiceGain.gain.cancelScheduledValues(now);
                            voiceGain.gain.setTargetAtTime(0.0001, now, 0.02);
                            src.stop(now + 0.09);
                        } catch (_) {}
                    });
                    deck.activeMidiVoices.delete(note);
                }

                function panicMidiNotes() {
                    Array.from(deck.activeMidiVoices.keys()).forEach((note) => releaseMidiNote(note));
                }

                async function exportCurrentSliceToWav() {
                    if (!deck.currentBuffer) {
                        updateMidiStatus(`Deck ${deck.name}: no sample loaded to export.`, true);
                        return;
                    }

                    const sourceRate = deck.currentBuffer.sampleRate;
                    const totalFrames = deck.currentBuffer.length;
                    const startFrame = Math.max(0, Math.floor(totalFrames * deck.regionStart));
                    const endFrame = Math.min(totalFrames, Math.ceil(totalFrames * deck.regionEnd));
                    const sliceLength = Math.max(1, endFrame - startFrame);
                    const sourceChannels = deck.currentBuffer.numberOfChannels;

                    // Offline render through same processing topology used in real-time playback.
                    const offline = new OfflineAudioContext(2, sliceLength, sourceRate);
                    const t0 = 0;

                    const slicedBuffer = offline.createBuffer(sourceChannels, sliceLength, sourceRate);
                    for (let ch = 0; ch < sourceChannels; ch++) {
                        const src = deck.currentBuffer.getChannelData(ch);
                        slicedBuffer.copyToChannel(src.slice(startFrame, endFrame), ch);
                    }

                    // Distortion
                    const distIn = offline.createGain();
                    const distBypass = offline.createGain();
                    const driveGain = offline.createGain();
                    const shaper = offline.createWaveShaper();
                    shaper.oversample = '4x';
                    const toneFilter = offline.createBiquadFilter();
                    toneFilter.type = 'lowpass';
                    const distLevel = offline.createGain();
                    const distOut = offline.createGain();

                    // Delay
                    const delayNode = offline.createDelay(1.2);
                    const delayFeedback = offline.createGain();
                    const delayFilter = offline.createBiquadFilter();
                    delayFilter.type = 'lowpass';
                    const delayWet = offline.createGain();

                    // Reverb / Pre-Verb
                    const preDelay = offline.createDelay(0.2);
                    const modDelay = offline.createDelay(0.05);
                    const modBypass = offline.createGain();
                    const lfo = offline.createOscillator();
                    const lfoGain = offline.createGain();
                    const modDepth = offline.createGain();
                    lfo.type = 'sine';
                    lfo.connect(lfoGain);
                    lfoGain.connect(modDepth);
                    modDepth.connect(modDelay.delayTime);
                    const convolver = offline.createConvolver();
                    const lowCut = offline.createBiquadFilter();
                    lowCut.type = 'highpass';
                    const highCut = offline.createBiquadFilter();
                    highCut.type = 'lowpass';
                    const dryGain = offline.createGain();
                    const wetGain = offline.createGain();

                    // Dynamics
                    const dynIn = offline.createGain();
                    const dynBypass = offline.createGain();
                    const compressor = offline.createDynamicsCompressor();
                    compressor.knee.value = 24;
                    compressor.attack.value = 0.006;
                    compressor.release.value = 0.18;
                    const makeupGain = offline.createGain();
                    const dynOut = offline.createGain();

                    // Master
                    const masterGain = offline.createGain();

                    // routing
                    distIn.connect(driveGain);
                    driveGain.connect(shaper);
                    shaper.connect(toneFilter);
                    toneFilter.connect(distLevel);
                    distLevel.connect(distOut);
                    distBypass.connect(distOut);

                    distOut.connect(dryGain);

                    distOut.connect(delayNode);
                    delayNode.connect(delayFilter);
                    delayFilter.connect(delayWet);
                    delayFilter.connect(delayFeedback);
                    delayFeedback.connect(delayNode);

                    distOut.connect(preDelay);
                    preDelay.connect(modDelay);
                    preDelay.connect(modBypass);
                    modDelay.connect(convolver);
                    modBypass.connect(convolver);
                    convolver.connect(lowCut);
                    lowCut.connect(highCut);
                    highCut.connect(wetGain);

                    const sum = offline.createGain();
                    dryGain.connect(sum);
                    wetGain.connect(sum);
                    delayWet.connect(sum);

                    sum.connect(dynIn);
                    dynIn.connect(compressor);
                    compressor.connect(makeupGain);
                    makeupGain.connect(dynOut);
                    dynBypass.connect(dynOut);

                    dynOut.connect(masterGain);
                    masterGain.connect(offline.destination);

                    const sourceNode = offline.createBufferSource();
                    sourceNode.buffer = slicedBuffer;
                    const deckOutGain = offline.createGain();
                    deckOutGain.gain.setValueAtTime(getDeckOutputGain(), t0);
                    sourceNode.connect(deckOutGain);
                    deckOutGain.connect(distIn);
                    deckOutGain.connect(distBypass);

                    // module states
                    const distEnabled = getModuleEnabled('Distortion');
                    const preVerbEnabled = getModuleEnabled('Pre-Verb');
                    const preverbMode = moduleModeState.preverb;
                    const reverbMode = moduleModeState.reverb;
                    const delayEnabled = getModuleEnabled('Delay');
                    const reverbEnabled = getModuleEnabled('Reverb');
                    const dynamicsEnabled = getModuleEnabled('Dynamics');

                    distIn.gain.setValueAtTime(distEnabled ? 1 : 0, t0);
                    distBypass.gain.setValueAtTime(distEnabled ? 0 : 1, t0);
                    dynIn.gain.setValueAtTime(dynamicsEnabled ? 1 : 0, t0);
                    dynBypass.gain.setValueAtTime(dynamicsEnabled ? 0 : 1, t0);

                    // knobs to params
                    const drive = getKnobValue('Drive', 65);
                    const tone = getKnobValue('Tone', 40);
                    const level = getKnobValue('Level', 80);
                    const size = getKnobValue('Size', 30);
                    const diff = getKnobValue('Diff', 75);
                    const mod = getKnobValue('Mod', 20);
                    const decay = getKnobValue('Decay', 85);
                    const low = getKnobValue('Low Cut', 50);
                    const high = getKnobValue('High Cut', 60);
                    const dTime = getKnobValue('Time', 35);
                    const dFeedback = getKnobValue('Feedback', 40);
                    const dMix = getKnobValue('Mix', 25);
                    const thresh = getKnobValue('Thresh', 0);
                    const ratio = getKnobValue('Ratio', 4);
                    const makeup = getKnobValue('Gain', 9);
                    const master = getKnobValue('Master', 90);

                    const distNorm = clamp(drive / 100, 0, 1);
                    driveGain.gain.setValueAtTime(1 + distNorm * 19, t0);
                    shaper.curve = makeDistortionCurve(distNorm);

                    const toneNorm = clamp(tone / 100, 0, 1);
                    const toneHz = 500 * Math.pow(24, toneNorm);
                    toneFilter.frequency.setValueAtTime(toneHz, t0);
                    toneFilter.Q.setValueAtTime(0.5 + toneNorm * 1.5, t0);
                    distLevel.gain.setValueAtTime(clamp(level / 100, 0, 1) * 1.6, t0);

                    const delayTimeNorm = clamp(dTime / 100, 0, 1);
                    delayNode.delayTime.setValueAtTime(0.03 + delayTimeNorm * 0.87, t0);
                    delayFeedback.gain.setValueAtTime(delayEnabled ? clamp(dFeedback / 100, 0, 1) * 0.92 : 0, t0);
                    delayFilter.frequency.setValueAtTime(6800, t0);
                    delayWet.gain.setValueAtTime(delayEnabled ? clamp(dMix / 100, 0, 1) * 0.8 : 0, t0);

                    const sizeNorm = clamp(size / 100, 0, 1);
                    const preVerbOn = preVerbEnabled ? 1 : 0;
                    const preDelaySeconds = preverbMode === 'freeze' ? 0.045 : (preverbMode === 'kill' ? 0.012 : sizeNorm * 0.06);
                    preDelay.delayTime.setValueAtTime(preVerbOn ? preDelaySeconds : 0, t0);

                    const modNorm = preVerbOn ? clamp(mod / 100, 0, 1) : 0;
                    lfo.frequency.setValueAtTime(0.2 + modNorm * 2.0, t0);
                    lfoGain.gain.setValueAtTime(1.0, t0);
                    const modDepthSeconds = preverbMode === 'freeze' ? Math.max(modNorm * 0.008, 0.004) : modNorm * 0.008;
                    modDepth.gain.setValueAtTime(modDepthSeconds, t0);
                    modDelay.delayTime.setValueAtTime(0.010, t0);
                    modBypass.gain.setValueAtTime(preVerbOn ? 0 : 1, t0);
                    lfo.start(0);

                    let wet = reverbMode === 'plate'
                        ? clamp(0.08 + sizeNorm * 0.50, 0.08, 0.70)
                        : clamp(0.14 + sizeNorm * 0.72, 0.14, 0.92);
                    let dry = clamp(1.0 - wet * 0.60, 0.20, 1.0);
                    if (preverbMode === 'kill') {
                        wet = clamp(wet * 0.45, 0.06, 0.40);
                        dry = clamp(1.0 - wet * 0.30, 0.72, 1.0);
                    }
                    if (preverbMode === 'freeze') {
                        wet = Math.max(wet, 0.92);
                        dry = Math.min(dry, 0.22);
                    }
                    dryGain.gain.setValueAtTime(dry, t0);
                    wetGain.gain.setValueAtTime(reverbEnabled ? wet : 0, t0);

                    const lowNorm = clamp(low / 100, 0, 1);
                    lowCut.frequency.setValueAtTime(20 * Math.pow(40, lowNorm), t0);
                    lowCut.Q.setValueAtTime(0.7, t0);

                    const highNorm = clamp(high / 100, 0, 1);
                    highCut.frequency.setValueAtTime(16000 * Math.pow(0.0625, 1 - highNorm), t0);
                    highCut.Q.setValueAtTime(0.7, t0);

                    const thr = -60 + (clamp(thresh / 100, 0, 1) * 60);
                    compressor.threshold.setValueAtTime(thr, t0);
                    compressor.ratio.setValueAtTime(clamp(ratio, 1, 20), t0);
                    makeupGain.gain.setValueAtTime(dbToGain(clamp(makeup, 0, 24)), t0);
                    masterGain.gain.setValueAtTime(Math.pow(clamp(master / 100, 0, 1), 1.6), t0);

                    if (reverbEnabled) {
                        const decayNorm = clamp(decay / 100, 0, 1);
                        const diffNorm = clamp(diff / 100, 0, 1);
                        let seconds = clamp(0.35 + sizeNorm * 1.1 + decayNorm * 7.0, 0.35, 10.0);
                        let diffusion = diffNorm;
                        if (preverbMode === 'kill') {
                            seconds = clamp(seconds * 0.58, 0.25, 5.0);
                            diffusion = clamp(diffusion * 0.72, 0, 1);
                        }
                        if (preverbMode === 'freeze') {
                            seconds = 12.0;
                            diffusion = 0.98;
                        }
                        if (reverbMode === 'plate') {
                            seconds = clamp(seconds * 0.78, 0.35, 8.0);
                            diffusion = clamp(diffusion * 0.85, 0, 1);
                        }
                        const irLen = Math.max(1, Math.floor(sourceRate * seconds));
                        const ir = offline.createBuffer(2, irLen, sourceRate);
                        const diffExp = 0.8 + diffusion * 3.2;
                        for (let ch = 0; ch < 2; ch++) {
                            const data = ir.getChannelData(ch);
                            for (let i = 0; i < irLen; i++) {
                                const tt = i / irLen;
                                const env = Math.pow(1 - tt, diffExp);
                                data[i] = (Math.random() * 2 - 1) * env;
                            }
                        }
                        convolver.buffer = ir;
                    } else {
                        const pass = offline.createBuffer(2, 1, sourceRate);
                        pass.getChannelData(0)[0] = 1;
                        pass.getChannelData(1)[0] = 1;
                        convolver.buffer = pass;
                    }

                    sourceNode.start(0, 0, slicedBuffer.duration);
                    const rendered = await offline.startRendering();

                    const renderedChannels = [];
                    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
                        renderedChannels.push(rendered.getChannelData(ch).slice());
                    }

                    const wavBlob = encodeWavFromChannels(renderedChannels, rendered.sampleRate);
                    const url = URL.createObjectURL(wavBlob);
                    const a = document.createElement('a');
                    const deckName = String(deck.name || 'Deck').toUpperCase();
                    a.href = url;
                    a.download = `sample_${deckName}_${Date.now()}.wav`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);

                    updateMidiStatus(`Deck ${deckName}: exported processed slice as WAV.`);
                }

                if (deck.importBtn && deck.fileInput) {
                    deck.importBtn.addEventListener('click', () => {
                        initAudioContext();
                        deck.fileInput.click();
                    });

                    deck.fileInput.addEventListener('change', (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;

                        const li = document.createElement('li');
                        li.textContent = file.name;
                        li.dataset.type = 'imported';

                        deck.sampleList?.querySelectorAll('li').forEach((item) => item.classList.remove('active'));
                        deck.sampleList?.appendChild(li);
                        li.classList.add('active');
                        li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

                        const reader = new FileReader();
                        reader.onload = (ev) => {
                            const arrayBuffer = ev.target?.result;
                            if (!audioContext || !arrayBuffer) return;
                            audioContext.decodeAudioData(arrayBuffer, (buffer) => {
                                deck.currentBuffer = buffer;
                                resetRegion();
                                drawWaveform();
                                ensureFxGraph();
                            }, (err) => console.error('Error decoding audio', err));
                        };
                        reader.readAsArrayBuffer(file);
                        deck.fileInput.value = '';
                    });
                }

                deck.playBtn?.addEventListener('click', playSample);
                deck.stopBtn?.addEventListener('click', stopSample);
                deck.loopBtn?.addEventListener('click', () => {
                    deck.isLooping = !deck.isLooping;
                    updateLoopButtonUI();
                    updateSourceLoopingFromRegion();
                });

                deck.exportBtn?.addEventListener('click', exportCurrentSliceToWav);
                deck.muteBtn?.addEventListener('click', () => setDeckMuted(!deck.muted));

                deck.volumeSlider?.addEventListener('input', (e) => {
                    updateDeckVolume(e.target.value);
                });
                updateDeckVolume(deck.volumeSlider?.value ?? 80);
                updateDeckMuteUI();

                deck.sampleList?.querySelectorAll('li').forEach((item) => {
                    item.addEventListener('click', () => {
                        deck.sampleList.querySelectorAll('li').forEach((i) => i.classList.remove('active'));
                        item.classList.add('active');

                        if (item.dataset.type === 'default') {
                            deck.currentBuffer = null;
                            resetRegion();
                            drawWaveform();
                        }
                    });
                });

                deck.canvas?.addEventListener('mousedown', (e) => {
                    const rect = deck.canvas.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const hit = handleHit(x);
                    deck.isDraggingStart = hit === 'start';
                    deck.isDraggingEnd = hit === 'end';
                });

                window.addEventListener('mousemove', (e) => {
                    if (!deck.canvas) return;
                    const rect = deck.canvas.getBoundingClientRect();
                    const x = e.clientX - rect.left;

                    if (!deck.isDraggingStart && !deck.isDraggingEnd) {
                        const hit = handleHit(x);
                        deck.canvas.style.cursor = hit ? 'ew-resize' : 'default';
                        return;
                    }

                    const width = rect.width;
                    const percent = clamp(x / width, 0, 1);
                    if (deck.isDraggingStart) {
                        deck.regionStart = Math.min(percent, deck.regionEnd - 0.01);
                        drawWaveform();
                        updateSourceLoopingFromRegion();
                    } else if (deck.isDraggingEnd) {
                        deck.regionEnd = Math.max(percent, deck.regionStart + 0.01);
                        drawWaveform();
                        updateSourceLoopingFromRegion();
                    }
                });

                window.addEventListener('mouseup', () => {
                    deck.isDraggingStart = false;
                    deck.isDraggingEnd = false;
                });

                updateLoopButtonUI();
                drawWaveform();

                return {
                    drawWaveform,
                    playSample,
                    stopSample,
                    triggerMidiNote,
                    releaseMidiNote,
                    panicMidiNotes,
                    setDeckMuted,
                    toggleLoop: () => {
                        deck.isLooping = !deck.isLooping;
                        updateLoopButtonUI();
                        updateSourceLoopingFromRegion();
                    }
                };
            }

            samplerDecks = deckElements.map((root, index) => createSamplerDeck(root, index));

            function startSyncedDecksFromInternal(note, velocity = 110) {
                initAudioContext();
                ensureFxGraph();
                if (!audioContext) return;
                const t0 = audioContext.currentTime + 0.03;
                samplerDecks[0]?.triggerMidiNote?.(note, velocity, midiConfig.rootNote, { startTime: t0 });
                samplerDecks[1]?.triggerMidiNote?.(note, velocity, midiConfig.rootNote, { startTime: t0 });
            }

            function stopSyncedDecksFromInternal(note) {
                samplerDecks[0]?.releaseMidiNote?.(note);
                samplerDecks[1]?.releaseMidiNote?.(note);
            }

            // Keyboard shortcut: L toggles loop on deck A.
            window.addEventListener('keydown', (e) => {
                const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
                if (tag === 'input' || tag === 'textarea') return;
                if (e.key && e.key.toLowerCase() === 'l') {
                    samplerDecks[0]?.toggleLoop();
                }
            });

            // Resize handler
            window.addEventListener('resize', () => samplerDecks.forEach((deck) => deck.drawWaveform()));
        });
    
