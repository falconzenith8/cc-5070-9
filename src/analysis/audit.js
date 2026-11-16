import { ShakeRig, sampleRig } from '../shake/rig.js';
import { amplitudeSpectrum, peakInRange } from './fft.js';
import { resampleUniform } from './resample.js';
import { maxStep, mean, peak, positionOf, rms, translationMagnitude, rotationMagnitude } from './trajectory.js';
import { buildPreset, PRESETS } from '../shake/schedule.js';
import { quatAngle } from '../shake/quaternion.js';

const HIGH_RATE = 480;
const AUDIT_SEED = 4242;

function metricRig({ preset = 'combined', seed = AUDIT_SEED, spectrum, space = 'local', events } = {}) {
  return new ShakeRig({
    seed,
    spectrum,
    space,
    events: events ?? buildPreset(preset),
  });
}

function maxDisplacement(samples) {
  let max = 0;
  let time = 0;
  for (const s of samples) {
    const value = translationMagnitude(s);
    if (value > max) {
      max = value;
      time = s.time;
    }
  }
  return { meters: max, time };
}

function maxRotation(samples) {
  let max = 0;
  let time = 0;
  for (const s of samples) {
    const value = rotationMagnitude(s);
    if (value > max) {
      max = value;
      time = s.time;
    }
  }
  return { degrees: max, time };
}

/** Boundary audit: displacement and its slope must approach zero at both ends. */
function boundaryAudit(rig, event, rate = 960) {
  const dt = 1 / rate;
  const start = event.start;
  const end = event.start + event.duration;
  const before = rig.evaluate(start - dt);
  const atStart = rig.evaluate(start);
  const after = rig.evaluate(start + dt);
  const beforeEnd = rig.evaluate(end - dt);
  const atEnd = rig.evaluate(end);
  const afterEnd = rig.evaluate(end + dt);
  const mag = (state) => Math.hypot(
    state.shake.translationWorld.x,
    state.shake.translationWorld.y,
    state.shake.translationWorld.z,
  );
  return {
    startBoundary: mag(atStart),
    startNeighborhood: Math.max(mag(before), mag(after)),
    endBoundary: mag(atEnd),
    endNeighborhood: Math.max(mag(beforeEnd), mag(afterEnd)),
    nearZero: mag(atStart) < 1e-12 && mag(atEnd) < 1e-12,
  };
}

export function auditImpulse({ seed = AUDIT_SEED, spectrum, space = 'local' } = {}) {
  const events = buildPreset('impulse');
  const event = events[0];
  const rig = new ShakeRig({ seed, spectrum, space, events });
  const total = event.start + event.duration + 1.5;
  const { samples } = sampleRig(rig, { duration: total, rate: HIGH_RATE });

  const displacement = maxDisplacement(samples);
  const rotation = maxRotation(samples);
  const envelope = samples.map((s) => s.envelope);
  const envelopePeak = peak(envelope);
  const values = samples.map((s) => translationMagnitude(s));
  const step = maxStep(values, 1 / HIGH_RATE);
  const steady = 1 / HIGH_RATE;

  const residualAfter = rig.residual(event.start + event.duration + 1.0);
  const envelopeAtEnd = event.start + event.duration;
  const endEnv = rig.evaluate(envelopeAtEnd).envelopeMax;
  const boundaries = boundaryAudit(rig, event);

  return {
    label: 'Single impulse',
    event: { id: event.id, start: event.start, duration: event.duration },
    peakMeters: displacement.meters,
    peakAt: displacement.time,
    peakDegrees: rotation.degrees,
    peakEnvelope: envelopePeak.magnitude,
    envelopeStartZero: rig.evaluate(event.start).envelopeMax === 0,
    envelopeEndZero: endEnv === 0,
    residualAfterEnd: {
      positionMeters: residualAfter.positionError,
      rotationRadians: residualAfter.rotationError,
      exact: residualAfter.exact,
    },
    boundaries,
    maxStep: step.value,
    maxStepRate: step.rate,
    durationSamples: samples.length,
    decayZeroAt: envelopeAtEnd,
    endEnvelopeZero: endEnv === 0,
    maxStepMetersPerSecond: step.rate,
    cleanDecay: residualAfter.exact && endEnv === 0,
    steadyStep: steady,
  };
}

export function auditEngine({ seed = AUDIT_SEED, spectrum, space = 'local' } = {}) {
  const events = buildPreset('engine');
  const event = events[0];
  const rig = new ShakeRig({ seed, spectrum, space, events });
  const total = event.start + event.duration + 1.5;
  const { samples } = sampleRig(rig, { duration: total, rate: HIGH_RATE });

  const attackEnd = event.start + event.attack;
  const releaseStart = event.start + event.duration - event.release;
  const steadySamples = samples.filter((s) => s.time >= attackEnd + 0.5 && s.time <= releaseStart - 0.5);
  const early = samples.filter((s) => s.time >= event.start + 0.1 && s.time <= event.start + 0.35);
  const late = steadySamples;
  const steady = steadySamples.map((s) => translationMagnitude(s));
  const steadyEnvelope = steadySamples.map((s) => s.envelope);
  const steadyRms = rms(steady);
  const steadyPeak = peak(steady);

  // Stationarity is a drift question, not a "two windows have identical RMS"
  // question: a 2 Hz rumble legitimately breathes. Compare the mean vectors of
  // the first and last half-second, and the signed RMS of both halves.
  const half = Math.floor(steady.length / 2);
  const firstHalf = rms(steady.slice(0, half));
  const secondHalf = rms(steady.slice(half));
  const componentMeans = { x: 0, y: 0, z: 0 };
  for (const s of steadySamples) {
    componentMeans.x += s.shakeTranslationWorld.x / steadySamples.length;
    componentMeans.y += s.shakeTranslationWorld.y / steadySamples.length;
    componentMeans.z += s.shakeTranslationWorld.z / steadySamples.length;
  }
  const dcOffset = Math.hypot(componentMeans.x, componentMeans.y, componentMeans.z);

  // Signed component with the most energy drives the spectral readout; taking
  // a magnitude first would rectify the waveform and fold band energy.
  const axes = ['x', 'y', 'z'].map((key) => ({
    key,
    series: steadySamples.map((s) => s.shakeTranslationWorld[key]),
  }));
  const strongest = axes.reduce((a, b) => {
    const va = rms(a.series);
    const vb = rms(b.series);
    return vb > va ? b : a;
  });
  const measured = peakInRange(strongest.series, HIGH_RATE, { min: 0.3, max: 40 });
  const measuredPeak = { frequency: measured.frequency, axis: strongest.key, amplitude: measured.amplitude };

  const residualAfter = rig.residual(event.start + event.duration + 1.0);
  const boundaries = boundaryAudit(rig, event);
  const envelopeComplete = samples
    .filter((s) => s.time >= attackEnd + 0.4 && s.time <= releaseStart - 0.4)
    .every((s) => s.envelope > 0.9999);

  return {
    label: 'Continuous engine',
    event: { id: event.id, start: event.start, duration: event.duration },
    peakMeters: maxDisplacement(samples).meters,
    steadyRmsMeters: steadyRms,
    steadyPeakMeters: steadyPeak.magnitude,
    firstHalfRms: firstHalf,
    secondHalfRms: secondHalf,
    stationarityRatio: firstHalf > 0 ? secondHalf / firstHalf : 0,
    dcOffsetMeters: dcOffset,
    strongestAxis: strongest.key,
    envelopeHoldComplete: envelopeComplete,
    envelopeHoldMin: Math.min(...steadyEnvelope),
    measuredPeakFrequency: measuredPeak.frequency,
    residualAfterEnd: {
      positionMeters: residualAfter.positionError,
      rotationRadians: residualAfter.rotationError,
      exact: residualAfter.exact,
    },
    earlyRms: early.length ? rms(early.map(translationMagnitude)) : 0,
    boundaries,
    cleanDecay: residualAfter.exact,
    startTime: event.start,
    endTime: event.start + event.duration,
  };
}

/**
 * Compare identical declared times across different capture rates. Because the
 * rig is evaluated purely from absolute time, common times must agree exactly;
 * the resampled trajectory diff quantifies interpolation error only.
 */
export function auditFrameRates({ seed = AUDIT_SEED, spectrum, space = 'local', rates = [24, 30, 60, 144] } = {}) {
  const rig = metricRig({ preset: 'combined', seed, spectrum, space });
  const total = 7.6;
  const reference = sampleRig(rig, { duration: total, rate: 1000 });
  const results = rates.map((rate) => {
    const capture = sampleRig(rig, { duration: total, rate });
    const common = capture.samples.filter((s) => {
      const t = s.time;
      return Math.abs(t * 6 - Math.round(t * 6)) < 1e-9;
    });
    let maxPos = 0;
    let maxRot = 0;
    for (const c of common) {
      const ref = rig.evaluate(c.time);
      maxPos = Math.max(maxPos, Math.hypot(
        c.position.x - ref.final.position.x,
        c.position.y - ref.final.position.y,
        c.position.z - ref.final.position.z,
      ));
      const stateRot = c.rotation;
      const refRot = ref.final.rotation;
      maxRot = Math.max(maxRot, Math.abs(stateRot.pitch - refRot.pitch), Math.abs(stateRot.yaw - refRot.yaw), Math.abs(stateRot.roll - refRot.roll));
    }
    const at = (time) => rig.residual(time);
    const endResidual = at(total);
    const envelopeOff = rig.evaluate(total).envelopeMax;
    const interp = reference.samples.filter((s) => s.time <= total);
    const resampledAtRate = resampleUniform(
      interp.map((s) => ({ time: s.time, values: positionOf(s) })),
      rate,
    );
    // Sample the same rate grid directly from the rig (no interpolation), and
    // interpolate the 1 kHz reference onto that grid for a trajectory delta.
    let trajectoryRms = 0;
    let trajectoryMax = 0;
    for (const point of resampledAtRate) {
      const direct = rig.evaluate(point.time).final.position;
      const diff = Math.hypot(
        point.values[0] - direct.x,
        point.values[1] - direct.y,
        point.values[2] - direct.z,
      );
      trajectoryRms += diff * diff;
      trajectoryMax = Math.max(trajectoryMax, diff);
    }
    trajectoryRms = Math.sqrt(trajectoryRms / Math.max(1, resampledAtRate.length));
    return {
      rate,
      frames: capture.samples.length,
      commonTimes: common.length,
      maxCommonPositionError: maxPos,
      maxCommonRotationError: maxRot,
      trajectoryRms,
      trajectoryMax,
      endResidualMeters: endResidual.positionError,
      endEnvelope: envelopeOff,
      exactAtCommonTimes: maxPos < 1e-12 && maxRot < 1e-12,
    };
  });
  const worst = results.reduce((a, b) => (a.maxCommonPositionError >= b.maxCommonPositionError ? a : b));
  return {
    label: 'Frame-rate replay',
    rates,
    results,
    worstCommonPositionError: worst.maxCommonPositionError,
    allExactAtCommonTimes: results.every((r) => r.exactAtCommonTimes),
    maxTrajectoryRms: Math.max(...results.map((r) => r.trajectoryRms)),
    allCleanResidual: results.every((r) => r.endResidualMeters < 1e-12 && r.endEnvelope === 0),
  };
}

/** Isolate one band and confirm its spectral peak tracks the commanded frequency. */
export function auditSpectrum({ seed = AUDIT_SEED, spectrum, space = 'local' } = {}) {
  const base = { low: 2, mid: 7, high: 18, gainLow: 1, gainMid: 1, gainHigh: 1 };
  const spec = { ...base, ...(spectrum ?? {}) };
  const bands = ['low', 'mid', 'high'];
  const results = bands.map((band) => {
    const event = {
      id: `solo-${band}`,
      label: `Solo ${band}`,
      type: 'sustained',
      start: 1.5,
      duration: 3,
      attack: 0.8,
      release: 0.6,
      translationMeters: 1,
      rotationDegrees: 0,
      seedOffset: 5,
      axes: {
        translation: { x: 1, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
      },
      bands: { low: 0, mid: 0, high: 0, [band]: 1 },
    };
    const rig = new ShakeRig({ seed, spectrum: spec, space, events: [event] });
    const start = event.start + event.attack + 0.25;
    const end = event.start + event.duration - event.release - 0.25;
    const rate = 480;
    const frames = Math.round((end - start) * rate);
    const series = [];
    for (let i = 0; i < frames; i++) {
      const time = start + i / rate;
      series.push(rig.evaluate(time).shake.translationLocal.x);
    }
    const measured = peakInRange(series, rate, { min: 0.3, max: 45 });
    const commanded = Number(spec[band]);
    return {
      band,
      commanded,
      measured: measured.frequency,
      amplitude: measured.amplitude,
      error: Math.abs(measured.frequency - commanded),
      errorPercent: (Math.abs(measured.frequency - commanded) / commanded) * 100,
      pass: Math.abs(measured.frequency - commanded) <= Math.max(0.6, commanded * 0.18),
    };
  });
  return {
    label: 'Spectrum tracking',
    results,
    pass: results.every((r) => r.pass),
  };
}

export function auditSeedReproducibility({ seed = AUDIT_SEED, spectrum, space = 'local' } = {}) {
  const rigA = metricRig({ preset: 'combined', seed, spectrum, space });
  const rigB = metricRig({ preset: 'combined', seed, spectrum, space });
  const t = 2.375;
  const a = rigA.evaluate(t);
  const b = rigB.evaluate(t);
  const different = metricRig({ preset: 'combined', seed: seed + 1, spectrum, space }).evaluate(t);
  const same = Math.abs(a.final.position.x - b.final.position.x) < 1e-15
    && Math.abs(a.final.position.y - b.final.position.y) < 1e-15
    && Math.abs(a.final.position.z - b.final.position.z) < 1e-15;
  const differsBySeed = Math.abs(a.shake.translationLocal.x - different.shake.translationLocal.x) > 1e-9
    || Math.abs(a.shake.translationLocal.y - different.shake.translationLocal.y) > 1e-9;
  return { label: 'Seed reproducibility', same, differsBySeed, pass: same && differsBySeed };
}

export function runAudit(options = {}) {
  const impulse = auditImpulse(options);
  const engine = auditEngine(options);
  const frameRates = auditFrameRates(options);
  const spectrum = auditSpectrum(options);
  const seedCheck = auditSeedReproducibility(options);
  const pass = impulse.cleanDecay
    && impulse.boundaries.nearZero
    && engine.cleanDecay
    && engine.stationarityRatio > 0.86
    && engine.stationarityRatio < 1.16
    && engine.dcOffsetMeters < engine.steadyRmsMeters * 0.35
    && engine.measuredPeakFrequency <= 4
    && frameRates.allExactAtCommonTimes
    && frameRates.allCleanResidual
    && spectrum.pass
    && seedCheck.pass;
  return {
    generatedAt: new Date().toISOString(),
    impulse,
    engine,
    frameRates,
    spectrum,
    seedCheck,
    pass,
  };
}
