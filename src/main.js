import * as THREE from 'three';
import { createWorld } from './scene/world.js';
import { ChaseView } from './scene/chaseView.js';
import { ShakeRig } from './shake/rig.js';
import { PlaybackClock } from './shake/clock.js';
import { buildPreset, PRESETS, validateSpectrum, validateEvents, validateSeed } from './shake/schedule.js';
import { runAudit } from './analysis/audit.js';
import { amplitudeSpectrum, peakInRange } from './analysis/fft.js';
import { maxStep, translationMagnitude } from './analysis/trajectory.js';
import {
  analyzeFeedbackRecord,
  angularVelocityDegPerSecond,
  captureCameraFeedback,
  compareFeedbackRecords,
  uniformTimes,
} from './analysis/feedback.js';
import { PoseCamera, captureFrameCountFeedback, collectShakeTimingEvidence } from './analysis/shakeTiming.js';
import { quatFromEulerYXZ, quatMultiply } from './shake/quaternion.js';
import { drawEnvelopeChart, drawTrajectoryChart, drawShakeChart, drawSpectrumChart } from './ui/charts.js';

const els = {
  canvas: document.getElementById('scene-canvas'),
  viewport: document.getElementById('viewport'),
  clockPill: document.getElementById('clock-pill'),
  spacePill: document.getElementById('space-pill'),
  auditPill: document.getElementById('audit-pill'),
  hudBase: document.getElementById('hud-base'),
  hudShake: document.getElementById('hud-shake'),
  hudFinal: document.getElementById('hud-final'),
  hudClock: document.getElementById('hud-clock'),
  hudFrame: document.getElementById('hud-frame'),
  hudResidual: document.getElementById('hud-residual'),
  play: document.getElementById('btn-play'),
  restart: document.getElementById('btn-restart'),
  scrub: document.getElementById('scrub'),
  scrubOut: document.getElementById('scrub-out'),
  timeScale: document.getElementById('time-scale'),
  timeScaleOut: document.getElementById('time-scale-out'),
  seed: document.getElementById('seed-input'),
  space: document.getElementById('space-select'),
  lowHz: document.getElementById('low-hz'),
  midHz: document.getElementById('mid-hz'),
  highHz: document.getElementById('high-hz'),
  lowGain: document.getElementById('low-gain'),
  midGain: document.getElementById('mid-gain'),
  highGain: document.getElementById('high-gain'),
  lowOut: document.getElementById('low-out'),
  midOut: document.getElementById('mid-out'),
  highOut: document.getElementById('high-out'),
  lowGainOut: document.getElementById('low-gain-out'),
  midGainOut: document.getElementById('mid-gain-out'),
  highGainOut: document.getElementById('high-gain-out'),
  presetHint: document.getElementById('preset-hint'),
  envelope: document.getElementById('envelope-canvas'),
  envelopeLegend: document.getElementById('envelope-legend'),
  spectrumCanvas: document.getElementById('spectrum-canvas'),
  trajectoryCanvas: document.getElementById('trajectory-canvas'),
  shakeCanvas: document.getElementById('shake-canvas'),
  mPeak: document.getElementById('m-peak'),
  mPeakSub: document.getElementById('m-peak-sub'),
  mRot: document.getElementById('m-rot'),
  mRotSub: document.getElementById('m-rot-sub'),
  mEnv: document.getElementById('m-env'),
  mEnvSub: document.getElementById('m-env-sub'),
  mResidual: document.getElementById('m-residual'),
  mResidualSub: document.getElementById('m-residual-sub'),
  mFreq: document.getElementById('m-freq'),
  mFreqSub: document.getElementById('m-freq-sub'),
  mStep: document.getElementById('m-step'),
  mStepSub: document.getElementById('m-step-sub'),
  mOmega: document.getElementById('m-omega'),
  mOmegaSub: document.getElementById('m-omega-sub'),
  componentBody: document.getElementById('component-body'),
  auditButton: document.getElementById('btn-audit'),
  timingButton: document.getElementById('btn-timing'),
  timingSummary: document.getElementById('timing-summary'),
  timingDetail: document.getElementById('timing-detail'),
  auditStamp: document.getElementById('audit-stamp'),
  auditSummary: document.getElementById('audit-summary'),
  auditDetail: document.getElementById('audit-detail'),
  eventResults: document.getElementById('event-results'),
  toggleRig: document.getElementById('toggle-rig'),
  toggleAxes: document.getElementById('toggle-axes'),
  toggleStats: document.getElementById('toggle-stats'),
};

const state = {
  preset: 'combined',
  spectrum: { low: 2, mid: 7, high: 18, gainLow: 1, gainMid: 1, gainHigh: 1 },
  seed: 1337,
  space: 'local',
  axis: 'y',
  frames: 0,
  lastError: null,
  audit: null,
  timing: null,
  fps: 0,
  fpsFrames: 0,
  fpsElapsed: 0,
};

let events = buildPreset(state.preset);
let rig = new ShakeRig({
  seed: state.seed,
  spectrum: state.spectrum,
  space: state.space,
  events,
});
let clock = new PlaybackClock({
  duration: rig.duration,
  timeScale: Number(els.timeScale.value),
  mode: 'realtime',
  fixedStep: 1 / 120,
});

let liveStates = null;
let liveSpectrum = null;
let lastCameraQuat = null;
let lastCameraTime = null;
let liveAngularVelocity = 0;

// --- renderer ---------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas: els.canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(els.viewport.clientWidth, els.viewport.clientHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const world = createWorld();
const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.05, 120);
// Declared rotation convention: yaw, then pitch, then roll (three's YXZ).
camera.rotation.order = 'YXZ';

const axesHelper = new THREE.AxesHelper(1.4);
axesHelper.position.set(0, 0.02, 0);
world.scene.add(axesHelper);

const chase = new ChaseView(document.getElementById('chase-canvas'));

function resize() {
  const w = els.viewport.clientWidth;
  const h = els.viewport.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  chase.resize(document.getElementById('chase-canvas').clientWidth, document.getElementById('chase-canvas').clientHeight);
}
window.addEventListener('resize', resize);
resize();

// --- helpers ----------------------------------------------------------
const F = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const mm = (v) => `${(v * 1000).toFixed(2)} mm`;
const deg = (v) => `${v.toFixed(2)}°`;

function applyCamera(stateAtTime) {
  camera.position.set(
    stateAtTime.final.position.x,
    stateAtTime.final.position.y,
    stateAtTime.final.position.z,
  );
  camera.quaternion.set(
    stateAtTime.final.quaternion.x,
    stateAtTime.final.quaternion.y,
    stateAtTime.final.quaternion.z,
    stateAtTime.final.quaternion.w,
  );
  camera.updateMatrixWorld();
}

/** Angular speed of the rendered camera between two declared times. */
function measureAngularVelocity(previous, previousTime, current, currentTime) {
  if (!previous || previousTime == null) return null;
  const dt = currentTime - previousTime;
  if (!(dt > 1e-9)) return null;
  return angularVelocityDegPerSecond(previous, current, dt);
}

function setError(error) {
  const banner = document.getElementById('error-banner');
  if (!error) {
    banner?.remove();
    state.lastError = null;
    return;
  }
  state.lastError = error;
  if (banner) {
    banner.innerHTML = `<strong>Rig rejected:</strong> ${escapeHtml(error)}`;
    return;
  }
  const node = document.createElement('div');
  node.id = 'error-banner';
  node.className = 'error-banner';
  node.innerHTML = `<strong>Rig rejected:</strong> ${escapeHtml(error)}`;
  document.body.appendChild(node);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function validateAll() {
  const errors = [...validateSeed(state.seed), ...validateSpectrum(state.spectrum)];
  try {
    errors.push(...validateEvents(events, state.space));
  } catch (error) {
    errors.push({ message: error.message, field: 'events' });
  }
  return errors;
}

function rebuildRig({ preserveTime = true, resetClock = false } = {}) {
  const errors = validateAll();
  if (errors.length) {
    setError(errors.map((e) => e.message).join(' · '));
    return false;
  }
  setError(null);
  try {
    rig = new ShakeRig({
      seed: state.seed,
      spectrum: state.spectrum,
      space: state.space,
      events,
    });
  } catch (error) {
    setError(error.message);
    return false;
  }
  clock.setDuration(rig.duration);
  if (resetClock) clock.restart();
  else if (preserveTime) clock.seek(Math.min(clock.time, clock.duration));
  liveStates = null;
  liveSpectrum = null;
  updateDerivedCharts();
  return true;
}

function rebuildEventSet(nextEvents, { resetClock = false } = {}) {
  events = nextEvents;
  return rebuildRig({ resetClock });
}

// --- derived charts ---------------------------------------------------
function computeLiveSeries() {
  const duration = rig.duration;
  const rate = 240;
  const frames = Math.round(duration * rate);
  const states = [];
  for (let i = 0; i <= frames; i++) {
    states.push({ ...rig.evaluate(i / rate), time: i / rate });
  }
  liveStates = { states, rate, duration };
  return liveStates;
}

function computeLiveSpectrum() {
  const { states, rate } = computeLiveSeries();
  // Use the signed axis with the most energy. Rectifying |Δp| first would
  // fold high-band energy down and hide the commanded peaks.
  const axes = ['x', 'y', 'z'].map((axis) => ({
    axis,
    values: states.map((s) => (state.space === 'local' ? s.shake.translationLocal : s.shake.translationWorld)[axis]),
  }));
  const strongest = axes.reduce((a, b) => (rmsOf(b.values) > rmsOf(a.values) ? b : a));
  const mean = strongest.values.reduce((a, b) => a + b, 0) / Math.max(1, strongest.values.length);
  liveSpectrum = amplitudeSpectrum(strongest.values.map((v) => v - mean), { sampleRate: rate });
  liveSpectrum.axis = strongest.axis;
  return liveSpectrum;
}

function updateDerivedCharts() {
  try {
    computeLiveSeries();
    computeLiveSpectrum();
  } catch (error) {
    setError(error.message);
    return;
  }
  const eventMeta = rig.events.map((e) => ({ id: e.id, label: e.label, start: e.start, duration: e.duration }));
  const ctx = { duration: rig.duration, cursorTime: clock.time, events: eventMeta };
  drawEnvelopeChart(els.envelope, { states: liveStates.states, ...ctx });
  drawTrajectoryChart(els.trajectoryCanvas, { states: liveStates.states, ...ctx, axis: state.axis });
  drawShakeChart(els.shakeCanvas, { states: liveStates.states, ...ctx, axis: state.axis, space: state.space });
  drawSpectrumChart(els.spectrumCanvas, {
    spectrum: liveSpectrum,
    commanded: state.spectrum,
    cursorFrequency: null,
    label: spectrumLabel(),
  });
  renderLegend();
  renderEventResults();
}

/** Per-event measured results: peak displacement, peak envelope, end offset. */
function renderEventResults() {
  const rows = rig.events.map((event) => {
    const start = event.start;
    const end = event.start + event.duration;
    let peak = 0;
    let peakEnv = 0;
    const sampleRate = 960;
    const frames = Math.max(1, Math.round(event.duration * sampleRate));
    for (let i = 0; i <= frames; i++) {
      const t = start + i / sampleRate;
      const state = rig.evaluate(t);
      const c = state.contributions.find((x) => x.id === event.id);
      if (!c) continue;
      const m = Math.hypot(c.translation.x, c.translation.y, c.translation.z);
      if (m > peak) peak = m;
      if (c.envelope > peakEnv) peakEnv = c.envelope;
    }
    // Measure this event's own contribution at its end; other overlapping
    // events may still be active, so global residual would be misleading.
    const atEnd = rig.evaluate(end).contributions.find((x) => x.id === event.id);
    const ownEnd = atEnd ? Math.hypot(atEnd.translation.x, atEnd.translation.y, atEnd.translation.z) : 0;
    return `<tr class="${ownEnd < 1e-12 ? 'settled' : ''}">
      <td>${escapeHtml(event.label ?? event.id)}</td>
      <td>${start.toFixed(2)} s</td>
      <td>${end.toFixed(2)} s</td>
      <td>${mm(peak)}</td>
      <td>${peakEnv.toFixed(3)}</td>
      <td>${ownEnd < 1e-12 ? '0' : mm(ownEnd)}</td>
    </tr>`;
  });
  els.eventResults.innerHTML = rows.join('');
}

function spectrumLabel() {
  const axis = liveSpectrum?.axis?.toUpperCase() ?? 'Y';
  return `measured shake ${state.space} ${axis} · gain ${state.spectrum.gainLow.toFixed(2)}/${state.spectrum.gainMid.toFixed(2)}/${state.spectrum.gainHigh.toFixed(2)}`;
}

let liveEnvelopeValues = new Map();
let lastLegendMs = 0;
function renderLegend() {
  const colors = ['#28d7e0', '#ffb347', '#8f9dff', '#5ee39a'];
  els.envelopeLegend.innerHTML = rig.events
    .map((e, i) => {
      const live = liveEnvelopeValues.get(e.id);
      const badge = live != null ? ` · env ${live.toFixed(2)}` : '';
      return `<span><span class="swatch" style="background:${colors[i % colors.length]}"></span>${escapeHtml(e.label)} (${e.start.toFixed(2)}–${(e.start + e.duration).toFixed(2)}s)${badge}</span>`;
    })
    .join('');
}

// --- per-frame readouts ----------------------------------------------
function captureLiveAngularVelocity(time) {
  const current = {
    x: camera.quaternion.x,
    y: camera.quaternion.y,
    z: camera.quaternion.z,
    w: camera.quaternion.w,
  };
  const value = measureAngularVelocity(lastCameraQuat, lastCameraTime, current, time);
  lastCameraQuat = current;
  lastCameraTime = time;
  if (value != null) liveAngularVelocity = value;
  return liveAngularVelocity;
}

function updateReadouts(evaluated) {
  const { base, shake, final, contributions, envelopes, residual } = evaluated;

  els.hudBase.textContent =
    `p ${F(base.position.x, 3)} ${F(base.position.y, 3)} ${F(base.position.z, 3)}\n` +
    `r ${deg(base.rotation.pitch)} ${deg(base.rotation.yaw)} ${deg(base.rotation.roll)}`;
  els.hudShake.textContent =
    `Δp ${mm(shake.translationWorld.x)} ${mm(shake.translationWorld.y)} ${mm(shake.translationWorld.z)}\n` +
    `Δr ${deg(shake.rotationDeg.pitch)} ${deg(shake.rotationDeg.yaw)} ${deg(shake.rotationDeg.roll)}`;
  els.hudFinal.textContent =
    `p ${F(final.position.x, 3)} ${F(final.position.y, 3)} ${F(final.position.z, 3)}\n` +
    `r ${deg(final.rotation.pitch)} ${deg(final.rotation.yaw)} ${deg(final.rotation.roll)}`;

  els.hudClock.textContent = `${clock.mode === 'fixed-step' ? 'fixed step' : 'realtime'} · ${clock.state} · ${clock.time.toFixed(3)}s`;
  els.hudFrame.textContent = `${state.frames} frames · ${state.fps.toFixed(0)} fps · rate ${liveStates?.rate ?? 240}Hz sim`;
  els.hudResidual.textContent = `${mm(residual.positionError)} / ${(residual.rotationError * 100).toFixed(4)}°`;

  const peak = peekLiveValues();
  els.mPeak.textContent = peak.peakMeters != null ? mm(peak.peakMeters) : '—';
  els.mPeakSub.textContent = peak.peakMeters != null ? `peak |Δpos| in ${liveStates?.duration.toFixed(2)}s window` : 'peak |Δpos| this cycle';
  els.mRot.textContent = peak.peakDegrees != null ? deg(peak.peakDegrees) : '—';
  els.mRotSub.textContent = `peak |Δrot| in window`;
  els.mEnv.textContent = peak.peakEnvelope != null ? peak.peakEnvelope.toFixed(3) : '—';
  els.mEnvSub.textContent = 'max normalized envelope';
  els.mResidual.textContent = `pos ${mm(residual.positionError)}`;
  els.mResidualSub.textContent = `rot ${(residual.rotationError * 100).toFixed(4)}° · ${residual.exact ? 'exact' : 'active'}`;

  const windowMetrics = peekSpectral();
  els.mFreq.textContent = windowMetrics.peak ? `${windowMetrics.peak.frequency.toFixed(2)} Hz` : '—';
  els.mFreqSub.textContent = windowMetrics.peak
    ? `${windowMetrics.peak.axis} axis · ${liveStates?.rate.toFixed(0)} Hz capture`
    : 'no window';
  els.mStep.textContent = windowMetrics.step ? mm(windowMetrics.step.value) : '—';
  els.mStepSub.textContent = windowMetrics.step ? `${(windowMetrics.step.rate * 1000).toFixed(1)} mm/s at ${liveStates?.rate.toFixed(0)}Hz` : 'per-frame position step';
  els.mOmega.textContent = `${liveAngularVelocity.toFixed(3)} °/s`;
  els.mOmegaSub.textContent = `Δq between rendered frames @ ${clock.time.toFixed(3)}s`;

  const rows = [];
  const axisLabel = state.axis;
  const posKeys = ['x', 'y', 'z'];
  const rotKeys = ['pitch', 'yaw', 'roll'];
  const row = (cls, label, values, unit) => {
    rows.push(`<tr class="${cls}"><td>${escapeHtml(label)}</td>${values.map((v) => `<td>${v}</td>`).join('')}<td class="unit">${unit}</td></tr>`);
  };
  row('component-base', 'base position', posKeys.map((k) => F(base.position[k], 3)), 'm');
  row('component-base', 'base rotation', rotKeys.map((k) => deg(base.rotation[k])), 'deg');
  row('component-shake', 'shake Δposition', posKeys.map((k) => mm(shake.translationWorld[k])), 'm');
  row('component-shake', 'shake Δrotation', rotKeys.map((k) => deg(shake.rotationDeg[k])), 'deg');
  row('component-final', 'final position', posKeys.map((k) => F(final.position[k], 3)), 'm');
  row('component-final', 'final rotation', rotKeys.map((k) => deg(final.rotation[k])), 'deg');
  els.componentBody.innerHTML = rows.join('');

  liveEnvelopeValues = new Map(envelopes.map((e) => [e.id, e.envelope]));
  if (performance.now() - lastLegendMs > 120) {
    lastLegendMs = performance.now();
    renderLegend();
  }
}

function peekLiveValues() {
  if (!liveStates) return {};
  let peakMeters = 0;
  let peakDegrees = 0;
  let peakEnvelope = 0;
  for (const s of liveStates.states) {
    const t = s.shake.translationWorld;
    const meters = Math.hypot(t.x, t.y, t.z);
    if (meters > peakMeters) peakMeters = meters;
    const r = s.shake.rotationDeg;
    const degrees = Math.hypot(r.pitch, r.yaw, r.roll);
    if (degrees > peakDegrees) peakDegrees = degrees;
    for (const e of s.envelopes) if (e.envelope > peakEnvelope) peakEnvelope = e.envelope;
  }
  return { peakMeters, peakDegrees, peakEnvelope };
}

function peekSpectral() {
  if (!liveStates) return {};
  const { states, rate } = liveStates;
  // Magnitude rectification would fold bands; take the signed axis with the
  // most energy instead, matching how the audit measures peaks.
  const axes = ['x', 'y', 'z'].map((axis) => ({
    axis,
    series: states.map((s) => s.shake.translationLocal[axis] * 1000),
  }));
  const strongest = axes.reduce((a, b) => (rmsOf(b.series) > rmsOf(a.series) ? b : a));
  const peak = peakInRange(strongest.series, rate, { min: 0.3, max: 45 });
  const samples = states.map((s) => translationMagnitude({ shakeTranslationWorld: s.shake.translationWorld }));
  const step = maxStep(samples, 1 / rate);
  return {
    peak: peak.amplitude > 0 ? { ...peak, axis: strongest.axis } : null,
    step,
  };
}

function rmsOf(values) {
  return Math.sqrt(values.reduce((a, b) => a + b * b, 0) / Math.max(1, values.length));
}

// --- animation loop ---------------------------------------------------
let lastFrameMs = performance.now();
function frame(now) {
  const rawDelta = (now - lastFrameMs) / 1000;
  lastFrameMs = now;
  const delta = Math.min(0.1, Math.max(0, rawDelta));

  state.fpsFrames += 1;
  state.fpsElapsed += delta;
  if (state.fpsElapsed >= 0.35) {
    state.fps = state.fpsFrames / state.fpsElapsed;
    state.fpsFrames = 0;
    state.fpsElapsed = 0;
  }

  if (clock.state === 'playing') clock.advance(delta);
  state.frames += 1;
  const evaluated = rig.evaluate(clock.time);
  applyCamera(evaluated);
  captureLiveAngularVelocity(clock.time);
  chase.update(evaluated);

  const residual = rig.residual(clock.time);
  updateReadouts({ ...evaluated, residual });

  axesHelper.visible = els.toggleAxes.checked;
  chase.canvas.parentElement.style.display = els.toggleRig.checked ? '' : 'none';
  els.hudFrame.parentElement.style.opacity = els.toggleStats.checked ? '1' : '0.25';

  updateTransportUI();

  renderer.render(world.scene, camera);
  chase.render();
  requestAnimationFrame(frame);
}

// --- transport UI -----------------------------------------------------
let lastChartTime = 0;
function updateTransportUI() {
  const playing = clock.state === 'playing';
  els.play.textContent = playing ? 'Pause' : clock.state === 'ended' ? 'Replay' : 'Play';
  els.play.classList.toggle('primary', playing || clock.state === 'ended');
  els.clockPill.textContent = `${clock.state} · ${clock.time.toFixed(2)}s`;
  els.clockPill.dataset.state = clock.state;
  els.spacePill.textContent = `${state.space} space`;
  els.scrub.value = String(Math.round(clock.progress * 1000));
  els.scrubOut.textContent = `${clock.time.toFixed(2)} s`;
  if (Math.abs(clock.time - lastChartTime) > 0.03) {
    lastChartTime = clock.time;
    if (liveStates) redrawChartsWithCursor();
  }
}

function redrawChartsWithCursor() {
  const eventMeta = rig.events.map((e) => ({ id: e.id, label: e.label, start: e.start, duration: e.duration }));
  const ctx = { duration: rig.duration, cursorTime: clock.time, events: eventMeta };
  drawEnvelopeChart(els.envelope, { states: liveStates.states, ...ctx });
  drawTrajectoryChart(els.trajectoryCanvas, { states: liveStates.states, ...ctx, axis: state.axis });
  drawShakeChart(els.shakeCanvas, { states: liveStates.states, ...ctx, axis: state.axis, space: state.space });
}

// --- interactions -----------------------------------------------------
els.play.addEventListener('click', () => {
  if (clock.state === 'playing') clock.pause();
  else {
    if (clock.state === 'ended') clock.restart();
    else clock.play();
  }
});
els.restart.addEventListener('click', () => {
  clock.restart();
  state.frames = 0;
});
els.scrub.addEventListener('input', () => {
  clock.seek((Number(els.scrub.value) / 1000) * clock.duration);
  if (clock.state === 'ended') clock.state = 'paused';
});
els.timeScale.addEventListener('input', () => {
  const value = Number(els.timeScale.value);
  clock.setTimeScale(value);
  els.timeScaleOut.textContent = `${value.toFixed(2)}×`;
});
els.seed.addEventListener('change', () => {
  const next = Number(els.seed.value);
  state.seed = Number.isFinite(next) ? Math.floor(next) : state.seed;
  els.seed.value = String(state.seed);
  if (rebuildRig()) clock.restart();
});
els.space.addEventListener('change', () => {
  state.space = els.space.value === 'world' ? 'world' : 'local';
  for (const e of events) e.space = state.space;
  if (rebuildRig()) clock.seek(clock.time);
});

const spectrumInputs = [
  [els.lowHz, 'low', els.lowOut, 2],
  [els.midHz, 'mid', els.midOut, 2],
  [els.highHz, 'high', els.highOut, 2],
  [els.lowGain, 'gainLow', els.lowGainOut, 2],
  [els.midGain, 'gainMid', els.midGainOut, 2],
  [els.highGain, 'gainHigh', els.highGainOut, 2],
];

for (const [input, key, output, digits] of spectrumInputs) {
  input.addEventListener('input', () => {
    const next = { ...state.spectrum, [key]: Number(input.value) };
    const errors = validateSpectrum(next);
    output.textContent = Number(input.value).toFixed(digits);
    if (errors.length) {
      setError(errors.map((e) => e.message).join(' · '));
      return;
    }
    setError(null);
    state.spectrum = next;
    rig.setSpectrum(state.spectrum);
    liveStates = null;
    liveSpectrum = null;
    updateDerivedCharts();
  });
}

for (const button of document.querySelectorAll('[data-preset]')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('primary'));
    button.classList.add('primary');
    state.preset = button.dataset.preset;
    els.presetHint.textContent = PRESETS[state.preset]?.hint ?? '';
    rebuildEventSet(buildPreset(state.preset), { resetClock: true });
    updateDerivedCharts();
  });
}

for (const button of document.querySelectorAll('[data-axis]')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-axis]').forEach((b) => b.classList.remove('primary'));
    button.classList.add('primary');
    state.axis = button.dataset.axis;
    updateDerivedCharts();
  });
}

els.toggleRig.addEventListener('change', () => {
  chase.canvas.parentElement.style.display = els.toggleRig.checked ? '' : 'none';
});
els.toggleAxes.addEventListener('change', () => { axesHelper.visible = els.toggleAxes.checked; });
els.toggleStats.addEventListener('change', () => {
  els.hudFrame.parentElement.style.opacity = els.toggleStats.checked ? '1' : '0.25';
});

// --- audit ------------------------------------------------------------
function runAndRenderAudit() {
  els.auditButton.disabled = true;
  els.auditSummary.textContent = 'running…';
  requestAnimationFrame(() => {
    const audit = runAudit({ seed: state.seed, spectrum: state.spectrum, space: state.space });
    state.audit = audit;
    renderAudit(audit);
    els.auditButton.disabled = false;
  });
}

function renderAudit(audit) {
  const passed = audit.pass;
  els.auditPill.textContent = passed ? 'audit pass' : 'audit fail';
  els.auditPill.classList.toggle('pill-good', passed);
  els.auditPill.classList.toggle('pill-bad', !passed);
  els.auditStamp.textContent = `audited ${new Date(audit.generatedAt).toLocaleTimeString()} · seed ${state.seed}`;
  els.auditSummary.textContent = passed ? 'all checks pass' : 'check failures';

  const row = (label, value, ok) => `<div class="audit-row ${ok ? 'pass' : 'fail'}"><span class="k">${label}</span><span class="v">${value}</span></div>`;
  const fmt = (v) => (Math.abs(v) < 1e-9 ? '0' : v.toExponential(2));
  const parts = [];

  parts.push(row('impulse peak', `${audit.impulse.peakMeters.toFixed(4)} m / ${audit.impulse.peakDegrees.toFixed(2)}°`, audit.impulse.cleanDecay));
  parts.push(row('impulse ends → base', `pos ${fmt(audit.impulse.residualAfterEnd.positionMeters)} m, rot ${fmt(audit.impulse.residualAfterEnd.rotationRadians)} rad`, audit.impulse.residualAfterEnd.exact));
  parts.push(row('envelope start/end', `0 at start · 0 at end`, audit.impulse.envelopeEndZero && audit.impulse.envelopeStartZero));
  parts.push(row('impulse max step', `${audit.impulse.maxStepRate.toFixed(1)} m/s @ 480 Hz`, true));

  const e = audit.engine;
  const engineOk = e.cleanDecay && e.envelopeHoldComplete && e.stationarityRatio > 0.86 && e.stationarityRatio < 1.16;
  parts.push(row('engine steady RMS', `${(e.steadyRmsMeters * 1000).toFixed(2)} mm · half ratio ${e.stationarityRatio.toFixed(3)}`, engineOk));
  parts.push(row('engine DC offset', `${(e.dcOffsetMeters * 1000).toFixed(3)} mm`, e.dcOffsetMeters < e.steadyRmsMeters * 0.35));
  parts.push(row('engine ends → base', `pos ${fmt(e.residualAfterEnd.positionMeters)} m`, e.residualAfterEnd.exact));
  parts.push(row('engine peak f', `${e.measuredPeakFrequency.toFixed(2)} Hz (${e.strongestAxis})`, e.measuredPeakFrequency <= 4));

  const f = audit.frameRates;
  const rateTable = `<table class="audit-table"><tr><th>rate</th><th>exact Δp</th><th>traj RMS</th><th>end residual</th></tr>${f.results
    .map((r) => `<tr><td>${r.rate} Hz</td><td>${r.maxCommonPositionError === 0 ? '0' : r.maxCommonPositionError.toExponential(1)}</td><td>${(r.trajectoryRms * 1000).toFixed(3)} mm</td><td>${r.endResidualMeters === 0 ? '0' : r.endResidualMeters.toExponential(1)}</td></tr>`)
    .join('')}</table>`;
  parts.push(row('frame-rate replay', `${f.results.length} rates · common-time Δp ${fmt(f.worstCommonPositionError)}`, f.allExactAtCommonTimes));
  parts.push(`<div class="audit-table-wrap">${rateTable}</div>`);

  const s = audit.spectrum;
  const specTable = `<table class="audit-table"><tr><th>band</th><th>command</th><th>measured</th><th>err</th></tr>${s.results
    .map((r) => `<tr><td>${r.band}</td><td>${r.commanded.toFixed(2)} Hz</td><td>${r.measured.toFixed(2)} Hz</td><td>${r.errorPercent.toFixed(1)}%</td></tr>`)
    .join('')}</table>`;
  parts.push(row('spectral peak tracking', `${s.results.map((r) => `${r.band} ${r.errorPercent.toFixed(1)}%`).join(' · ')}`, s.pass));
  parts.push(`<div class="audit-table-wrap">${specTable}</div>`);
  parts.push(row('seed reproducibility', `${audit.seedCheck.same ? 'identical' : 'differs'} / seed shifts signal ${audit.seedCheck.differsBySeed ? 'yes' : 'no'}`, audit.seedCheck.pass));

  els.auditDetail.innerHTML = `<div class="audit-grid">${parts.join('')}</div>`;
}

els.auditButton.addEventListener('click', runAndRenderAudit);

function runAndRenderTiming() {
  els.timingButton.disabled = true;
  els.timingSummary.textContent = 'running…';
  requestAnimationFrame(() => {
    const evidence = collectShakeTimingEvidence({
      seed: state.seed,
      rates: [24, 30, 60, 144],
      camera,
      spectrum: state.spectrum,
      space: state.space,
      duration: Math.max(rig.duration, 8.05),
    });
    state.timing = evidence;
    renderTiming(evidence);
    els.timingButton.disabled = false;
  });
}

function renderTiming(evidence) {
  const passed = evidence.pass;
  els.timingSummary.textContent = passed ? 'timing pass' : 'timing fail';
  const row = (label, value, ok) => `<div class="audit-row ${ok ? 'pass' : 'fail'}"><span class="k">${label}</span><span class="v">${value}</span></div>`;
  const exp = (v) => (Math.abs(v) < 1e-12 ? '0' : v.toExponential(2));
  const parts = [];
  for (const result of evidence.checks.feedback.results) {
    parts.push(row(
      `${result.rate} Hz feedback`,
      `${result.frames} frames · env ${exp(result.maxEnvelopeError)} · ω ${exp(result.maxAngularVelocityError)}`,
      result.pass,
    ));
  }
  parts.push(row(
    'shared declared times',
    `Δp ${exp(evidence.checks.feedback.maxSharedPositionError)} m · Δq ${exp(evidence.checks.feedback.maxSharedRotationError)} rad`,
    evidence.checks.feedback.sharedTimesExact,
  ));
  const env = evidence.evidence.envelope;
  parts.push(row(
    'envelope from raw record',
    `${evidence.evidence.envelope.rows.length} rows · max err ${exp(env.maxError)}${env.worst ? ` @ ${env.worst.time.toFixed(2)}s` : ''}`,
    env.maxError <= 1e-9,
  ));
  const ang = evidence.evidence.angularVelocity;
  parts.push(row(
    'angular velocity from raw record',
    `${evidence.evidence.angularVelocity.rows.length} rows · max err ${exp(ang.maxError)} °/s${ang.worst ? ` @ ${ang.worst.time.toFixed(2)}s` : ''}`,
    ang.maxError <= 1e-6,
  ));
  parts.push(row('runs to end', `${evidence.checks.completion.state} · residual ${exp(evidence.checks.completion.endResidualMeters)} m`, evidence.checks.completion.ok));
  parts.push(row('pause / resume', evidence.checks.pause.frozen ? `frozen at ${evidence.checks.pause.pausedAt.toFixed(2)}s` : 'time advanced while paused', evidence.checks.pause.ok));
  parts.push(row('repeated triggers', evidence.checks.repeated.probes.map((p) => p.id).join(', '), evidence.checks.repeated.ok));
  const neg = evidence.checks.negatives;
  parts.push(row('fault: envelope ×0.5', `max err ${exp(neg.envelope.maxEnvelopeError)} · reported ${neg.envelope.reportedPass ? 'pass' : 'fail'}`, neg.envelope.detected));
  parts.push(row('fault: camera rotation', `max ω err ${exp(neg.angularVelocity.maxAngularVelocityError)} °/s`, neg.angularVelocity.detected));
  parts.push(row('fault: frame-count timing', `Δp ${exp(neg.frameCount.maxSharedPositionError)} m · reported ${neg.frameCount.reportedPass24 ? 'pass' : 'fail'}`, neg.frameCount.detected));
  els.timingDetail.innerHTML = `<div class="audit-grid">${parts.join('')}</div>`;
}

els.timingButton.addEventListener('click', runAndRenderTiming);

// --- instrumentation (for automated browser checks) --------------------
window.__shakeLab = {
  get state() {
    return {
      time: clock.time,
      clockState: clock.state,
      timeScale: clock.timeScale,
      space: state.space,
      seed: state.seed,
      preset: state.preset,
      duration: rig.duration,
      frames: state.frames,
      fps: state.fps,
      error: state.lastError,
      auditPass: state.audit?.pass ?? null,
    };
  },
  setClockTime(time) {
    clock.seek(time);
    const evaluated = rig.evaluate(clock.time);
    applyCamera(evaluated);
    chase.update(evaluated);
    updateReadouts({ ...evaluated, residual: rig.residual(clock.time) });
    updateTransportUI();
    renderer.render(world.scene, camera);
    chase.render();
  },
  evalAt(time) {
    return rig.evaluate(time);
  },
  residualAt(time) {
    return rig.residual(time);
  },
  cameraTransform() {
    return {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      quaternion: { x: camera.quaternion.x, y: camera.quaternion.y, z: camera.quaternion.z, w: camera.quaternion.w },
      rotation: { pitch: camera.rotation.x, yaw: camera.rotation.y, roll: camera.rotation.z },
    };
  },
  pause() { clock.pause(); updateTransportUI(); },
  play() { clock.play(); },
  restart() { clock.restart(); state.frames = 0; },
  setSeed(nextSeed) {
    const errors = validateSeed(nextSeed);
    if (errors.length) {
      setError(errors.map((e) => e.message).join(' · '));
      return false;
    }
    setError(null);
    state.seed = Math.floor(Number(nextSeed));
    els.seed.value = String(state.seed);
    rebuildRig({ resetClock: true });
    updateDerivedCharts();
    return true;
  },
  setSpace(spaceValue) {
    state.space = spaceValue === 'world' ? 'world' : 'local';
    els.space.value = state.space;
    for (const ev of events) ev.space = state.space;
    rebuildRig();
    updateDerivedCharts();
  },
  setSpectrum(spectrum) {
    const next = { ...state.spectrum, ...spectrum };
    const errors = validateSpectrum(next);
    if (errors.length) {
      setError(errors.map((e) => e.message).join(' · '));
      return false;
    }
    setError(null);
    state.spectrum = next;
    els.lowHz.value = String(state.spectrum.low);
    els.midHz.value = String(state.spectrum.mid);
    els.highHz.value = String(state.spectrum.high);
    els.lowGain.value = String(state.spectrum.gainLow);
    els.midGain.value = String(state.spectrum.gainMid);
    els.highGain.value = String(state.spectrum.gainHigh);
    els.lowOut.textContent = state.spectrum.low.toFixed(2);
    els.midOut.textContent = state.spectrum.mid.toFixed(2);
    els.highOut.textContent = state.spectrum.high.toFixed(2);
    els.lowGainOut.textContent = state.spectrum.gainLow.toFixed(2);
    els.midGainOut.textContent = state.spectrum.gainMid.toFixed(2);
    els.highGainOut.textContent = state.spectrum.gainHigh.toFixed(2);
    rig.setSpectrum(state.spectrum);
    liveStates = null;
    liveSpectrum = null;
    updateDerivedCharts();
  },
  applyPreset(name) {
    document.querySelectorAll('[data-preset]').forEach((b) => {
      b.classList.toggle('primary', b.dataset.preset === name);
    });
    state.preset = name;
    els.presetHint.textContent = PRESETS[name]?.hint ?? '';
    rebuildEventSet(buildPreset(name), { resetClock: true });
    updateDerivedCharts();
  },
  setAxis(axis) {
    state.axis = axis;
    document.querySelectorAll('[data-axis]').forEach((b) => {
      b.classList.toggle('primary', b.dataset.axis === axis);
    });
    updateDerivedCharts();
  },
  runAudit() {
    const audit = runAudit({ seed: state.seed, spectrum: state.spectrum, space: state.space });
    state.audit = audit;
    renderAudit(audit);
    return audit;
  },
  captureFeedback({ rate = 60, duration = null } = {}) {
    const span = duration ?? Math.max(rig.duration, 5);
    return captureCameraFeedback(camera, rig, uniformTimes(span, rate), {});
  },
  analyzeFeedback(record) {
    return analyzeFeedbackRecord(record, { events: rig.events });
  },
  compareFeedback(a, b) {
    return compareFeedbackRecords(a, b);
  },
  captureFrameCountFeedback({ rate = 24, duration = null } = {}) {
    const span = duration ?? Math.max(rig.duration, 5);
    return captureFrameCountFeedback(camera, rig, uniformTimes(span, rate), rate);
  },
  timingEvidence({ rates = [24, 30, 60, 144], duration = null } = {}) {
    const evidence = collectShakeTimingEvidence({
      seed: state.seed,
      rates,
      camera,
      spectrum: state.spectrum,
      space: state.space,
      duration: duration ?? Math.max(rig.duration, 8.05),
    });
    state.timing = evidence;
    renderTiming(evidence);
    return evidence;
  },
  get timingPass() {
    return state.timing?.pass ?? null;
  },
  get angularVelocity() {
    return liveAngularVelocity;
  },
  measureTrajectory({ rate = 240, duration = 7.6 } = {}) {
    const samples = [];
    const frames = Math.round(duration * rate);
    for (let i = 0; i <= frames; i++) {
      const t = i / rate;
      const s = rig.evaluate(t);
      samples.push({ t, p: { ...s.final.position }, b: { ...s.base.position }, env: s.envelopeMax });
    }
    return samples;
  },
  countFrames() { return state.frames; },
  tickFrame() { state.frames += 1; },
  get errorBanner() {
    return document.getElementById('error-banner')?.textContent ?? null;
  },
  _internal: { get rig() { return rig; }, get clock() { return clock; }, get events() { return events; } },
};

// --- boot -------------------------------------------------------------
els.presetHint.textContent = PRESETS[state.preset].hint;
updateDerivedCharts();
// Populate the result area with a real audit of the default schedule.
requestAnimationFrame(() => runAndRenderAudit());
renderer.render(world.scene, camera);
chase.update(rig.evaluate(clock.time));
chase.render();
requestAnimationFrame(frame);

// Keep chart canvases crisp after layout changes.
new ResizeObserver(() => {
  resize();
  if (liveStates) {
    updateDerivedCharts();
  }
}).observe(els.viewport);

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === 'Space') {
    event.preventDefault();
    els.play.click();
  } else if (event.code === 'KeyR') {
    els.restart.click();
  }
});
