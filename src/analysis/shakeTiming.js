import { ShakeRig } from '../shake/rig.js';
import { PlaybackClock } from '../shake/clock.js';
import { buildPreset } from '../shake/schedule.js';
import { quatFromEulerYXZ, quatMultiply } from '../shake/quaternion.js';
import {
  analyzeFeedbackRecord,
  analyzeFeedbackSet,
  captureCameraFeedback,
  compareFeedbackRecords,
  uniformTimes,
} from './feedback.js';

const DEFAULT_SEED = 4242;
const FRAME_COUNT_FPS = 60;

/**
 * Minimal camera-pose sink. It exposes the same surface the renderer uses
 * (position.set / quaternion.set / updateMatrixWorld), so feedback is read
 * back from a transform object, not from the oscillator source.
 */
export class PoseCamera {
  constructor() {
    const position = {
      x: 0,
      y: 0,
      z: 0,
      set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const quaternion = {
      x: 0,
      y: 0,
      z: 0,
      w: 1,
      set(x, y, z, w) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
      },
    };
    this.position = position;
    this.quaternion = quaternion;
  }

  updateMatrixWorld() {}
}

function applyShakePose(camera, state) {
  camera.position.set(state.final.position.x, state.final.position.y, state.final.position.z);
  camera.quaternion.set(
    state.final.quaternion.x,
    state.final.quaternion.y,
    state.final.quaternion.z,
    state.final.quaternion.w,
  );
}

/**
 * Deliberately broken sampler: declared time advances by the capture rate,
 * but the evaluated pose advances by a fixed frame count. This is the
 * "frame-count timing" bug the acceptance must recognize.
 */
export function captureFrameCountFeedback(camera, rig, times, rate, { frameFps = FRAME_COUNT_FPS } = {}) {
  const record = [];
  for (let index = 0; index < times.length; index++) {
    const declaredTime = times[index];
    const frameTime = index / frameFps;
    const state = rig.evaluate(frameTime);
    applyShakePose(camera, state);
    camera.updateMatrixWorld(true);
    record.push({
      time: declaredTime,
      evaluatedTime: state.time,
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      quaternion: {
        x: camera.quaternion.x,
        y: camera.quaternion.y,
        z: camera.quaternion.z,
        w: camera.quaternion.w,
      },
      basePosition: { ...state.base.position },
      baseQuaternion: { ...state.base.quaternion },
      shakeRotationDeg: { ...state.shake.rotationDeg },
      shakeTranslationWorld: { ...state.shake.translationWorld },
      envelope: state.envelopeMax,
      envelopes: state.envelopes.map((entry) => ({ ...entry })),
      active: state.active,
    });
  }
  return record;
}

function pauseAndResumeCheck(duration, atTime = 1.2) {
  const clock = new PlaybackClock({ duration, timeScale: 1 });
  while (clock.time + 0.05 <= atTime) clock.advance(0.05);
  clock.pause();
  const pausedAt = clock.time;
  clock.advance(2.5);
  const frozen = clock.time === pausedAt;
  clock.play();
  clock.advance(0.05);
  const resumed = clock.time > pausedAt;
  return { pausedAt, frozen, resumed, ok: frozen && resumed };
}

function runToEndCheck(rig, duration) {
  const clock = new PlaybackClock({ duration, timeScale: 1, fixedStep: 1 / 120 });
  const steps = Math.ceil(duration * 120) + 8;
  clock.stepFixed(steps);
  const residual = rig.residual(duration);
  const envelope = rig.evaluate(duration).envelopeMax;
  return {
    reached: clock.time === duration,
    state: clock.state,
    endResidualMeters: residual.positionError,
    endResidualRadians: residual.rotationError,
    endEnvelope: envelope,
    ok: clock.time === duration && clock.state === 'ended' && residual.exact && envelope === 0,
  };
}

function repeatedTriggerCheck({ seed, duration }) {
  const events = buildPreset('regression');
  const rig = new ShakeRig({ seed, events });
  const camera = new PoseCamera();
  const probes = [];
  let ok = true;
  for (const event of rig.events) {
    const sampleAt = event.start + event.attack + Math.min(0.35, (event.duration - event.attack - event.release) * 0.5);
    const state = rig.evaluate(sampleAt);
    const contribution = state.contributions.find((c) => c.id === event.id);
    const window = uniformTimes(event.duration, 120).map((offset) => event.start + offset);
    const record = captureCameraFeedback(camera, rig, window, {});
    const analysis = analyzeFeedbackRecord(record, { events: rig.events });
    const afterEnd = rig.residual(event.start + event.duration + 0.05);
    const ownEnd = rig.evaluate(event.start + event.duration).contributions.find((c) => c.id === event.id);
    const ownEndMagnitude = ownEnd
      ? Math.hypot(ownEnd.translation.x, ownEnd.translation.y, ownEnd.translation.z)
      : 0;
    const peak = analysis.peakEnvelope;
    const pass = analysis.envelopeOk
      && analysis.angularVelocityOk
      && peak > 0.999
      && ownEndMagnitude < 1e-12
      && contribution?.envelope > 0;
    if (!pass) ok = false;
    probes.push({
      id: event.id,
      triggeredAt: event.start,
      sampledAt: sampleAt,
      envelope: state.envelopeMax,
      eventEnvelope: contribution?.envelope ?? 0,
      ownEndMeters: ownEndMagnitude,
      peakEnvelope: peak,
      envelopeError: analysis.maxEnvelopeError,
      angularVelocityError: analysis.maxAngularVelocityError,
      residualAfterEnd: afterEnd.positionError,
      pass,
    });
  }

  // Re-triggering the same sample must replay the identical raw record.
  const window = uniformTimes(1.0, 90).map((offset) => events[0].start + offset);
  const first = captureCameraFeedback(camera, rig, window, {});
  const second = captureCameraFeedback(camera, rig, window, {});
  const replay = compareFeedbackRecords(first, second);
  if (!replay.equal) ok = false;

  return { probes, replay, ok: ok && replay.equal };
}

function negativeChecks({ rig, camera, duration, events, envelopeTolerance, angularTolerance }) {
  const times = uniformTimes(duration, 60);

  const good = analyzeFeedbackRecord(captureCameraFeedback(camera, rig, times, {}), { events });
  const envelopeCorrupted = analyzeFeedbackRecord(
    captureCameraFeedback(camera, rig, times, { envelopeOf: (state) => state.envelopeMax * 0.5 }),
    { events },
  );
  const rotationCorrupted = analyzeFeedbackRecord(
    captureCameraFeedback(camera, rig, times, {
      afterPose: (target, { index }) => {
        const extra = quatFromEulerYXZ(0, (index % 2 === 0 ? 1 : -1) * 0.4, 0);
        target.quaternion.set(
          ...(() => {
            const q = quatMultiply(target.quaternion, extra);
            return [q.x, q.y, q.z, q.w];
          })(),
        );
      },
    }),
    { events },
  );

  const frameCount24 = analyzeFeedbackRecord(
    captureFrameCountFeedback(camera, rig, uniformTimes(duration, 24), 24),
    { events },
  );
  const frameCount60 = analyzeFeedbackRecord(
    captureFrameCountFeedback(camera, rig, uniformTimes(duration, 60), 60),
    { events },
  );
  const frameCountComparison = compareFeedbackRecords(
    captureFrameCountFeedback(camera, rig, uniformTimes(duration, 24), 24),
    captureFrameCountFeedback(camera, rig, uniformTimes(duration, 60), 60),
  );

  const envelopeDetected = good.envelopeOk && !envelopeCorrupted.envelopeOk
    && envelopeCorrupted.maxEnvelopeError > envelopeTolerance;
  const angularDetected = good.angularVelocityOk && !rotationCorrupted.angularVelocityOk
    && rotationCorrupted.maxAngularVelocityError > angularTolerance;
  const frameMismatchRates = [24, 60].filter((rate) => rate !== FRAME_COUNT_FPS);
  const frameCountDetected = frameMismatchRates.every((rate) => {
    const analysis = rate === 24 ? frameCount24 : frameCount60;
    return !analysis.declaredTimeOk && !analysis.pass;
  }) && !frameCountComparison.equal;

  return {
    good: { pass: good.pass, maxEnvelopeError: good.maxEnvelopeError, maxAngularVelocityError: good.maxAngularVelocityError },
    envelope: {
      detected: envelopeDetected,
      maxEnvelopeError: envelopeCorrupted.maxEnvelopeError,
      worst: envelopeCorrupted.worstEnvelope,
      reportedPass: envelopeCorrupted.pass,
    },
    angularVelocity: {
      detected: angularDetected,
      maxAngularVelocityError: rotationCorrupted.maxAngularVelocityError,
      worst: rotationCorrupted.worstAngularVelocity,
      reportedPass: rotationCorrupted.pass,
    },
    frameCount: {
      detected: frameCountDetected,
      declaredTimeOk24: frameCount24.declaredTimeOk,
      declaredTimeOk60: frameCount60.declaredTimeOk,
      maxSharedPositionError: frameCountComparison.maxPositionError,
      maxSharedRotationError: frameCountComparison.maxRotationError,
      sharedTimes: frameCountComparison.sharedTimes,
      reportedPass24: frameCount24.pass,
      reportedPass60: frameCount60.pass,
    },
    ok: envelopeDetected && angularDetected && frameCountDetected,
  };
}

/**
 * Collect reproducible shake-timing evidence. All envelope and angular-velocity
 * numbers are computed from the raw camera record produced here; the negative
 * probes inject controlled faults so a false "pass" cannot be reported.
 */
export function collectShakeTimingEvidence({
  seed = DEFAULT_SEED,
  rates = [24, 30, 60, 144],
  duration = null,
  envelopeTolerance = 1e-9,
  angularTolerance = 1e-6,
  camera = null,
  preset = 'regression',
  spectrum = null,
  space = 'local',
} = {}) {
  const events = buildPreset(preset);
  const rig = new ShakeRig({ seed, events, spectrum, space });
  const totalDuration = duration ?? Math.max(rig.duration, 5);
  const poseSink = camera ?? new PoseCamera();

  const feedback = analyzeFeedbackSet({
    rig,
    camera: poseSink,
    rates,
    duration: totalDuration,
    events: rig.events,
  });

  for (const result of feedback.results) {
    for (const row of result.rows) {
      row.envelopeOk = row.envelopeError <= envelopeTolerance;
      row.angularVelocityOk = row.angularVelocityError <= angularTolerance;
    }
  }

  const completion = runToEndCheck(rig, totalDuration);
  const pause = pauseAndResumeCheck(totalDuration, Math.min(1.2, totalDuration / 4));
  const repeated = repeatedTriggerCheck({ seed, duration: totalDuration });
  const negatives = negativeChecks({
    rig,
    camera: poseSink,
    duration: totalDuration,
    events: rig.events,
    envelopeTolerance,
    angularTolerance,
  });

  const rows = feedback.results.flatMap((result) => result.rows.map((row) => ({ rate: result.rate, ...row })));
  const ordered = [...rows].sort((a, b) => b.envelopeError - a.envelopeError);
  const angularOrdered = [...rows]
    .filter((row) => row.angularVelocityDegPerSecond != null)
    .sort((a, b) => b.angularVelocityError - a.angularVelocityError);

  // Keep the raw record verbatim so envelope and angular velocity can be
  // audited from primary evidence, not from this summary.
  const raw = feedback.results.map((result) => ({
    rate: result.rate,
    frames: result.record.length,
    samples: result.record,
  }));

  const envelopeEvidence = {
    maxError: feedback.results.reduce((m, result) => Math.max(m, result.maxEnvelopeError), 0),
    worst: ordered[0]
      ? {
        rate: ordered[0].rate,
        time: ordered[0].time,
        computed: ordered[0].envelope,
        reference: ordered[0].envelopeReference,
        error: ordered[0].envelopeError,
      }
      : null,
    rows: rows.map(({ rate, index, time, envelope, envelopeReference, envelopeError }) => ({
      rate,
      index,
      time,
      envelope,
      reference: envelopeReference,
      error: envelopeError,
    })),
  };
  const angularEvidence = {
    maxError: feedback.results.reduce((m, result) => Math.max(m, result.maxAngularVelocityError), 0),
    worst: angularOrdered[0]
      ? {
        rate: angularOrdered[0].rate,
        time: angularOrdered[0].time,
        computed: angularOrdered[0].angularVelocityDegPerSecond,
        reference: angularOrdered[0].angularVelocityReferenceDegPerSecond,
        error: angularOrdered[0].angularVelocityError,
      }
      : null,
    rows: rows.map(({
      rate,
      index,
      time,
      angularVelocityDegPerSecond,
      angularVelocityReferenceDegPerSecond,
      angularVelocityError,
    }) => ({
      rate,
      index,
      time,
      computed: angularVelocityDegPerSecond,
      reference: angularVelocityReferenceDegPerSecond,
      error: angularVelocityError,
    })),
  };

  const pass = feedback.pass
    && completion.ok
    && pause.ok
    && repeated.ok
    && negatives.ok
    && envelopeEvidence.maxError <= envelopeTolerance
    && angularEvidence.maxError <= angularTolerance;

  return {
    generatedAt: new Date().toISOString(),
    seed,
    duration: totalDuration,
    rates,
    sample: {
      frames: raw.map((entry) => ({ rate: entry.rate, frames: entry.frames })),
      raw,
    },
    checks: {
      feedback: {
        pass: feedback.pass,
        allRateChecksPass: feedback.allRateChecksPass,
        sharedTimesExact: feedback.sharedTimesExact,
        sharedPairs: feedback.sharedPairs,
        maxSharedPositionError: feedback.maxSharedPositionError,
        maxSharedRotationError: feedback.maxSharedRotationError,
        results: feedback.results.map(({ record, rows: resultRows, ...rest }) => ({ ...rest })),
      },
      completion,
      pause,
      repeated,
      negatives,
    },
    evidence: {
      envelope: envelopeEvidence,
      angularVelocity: angularEvidence,
    },
    pass,
  };
}

export function formatShakeTiming(evidence) {
  const lines = [];
  const row = (label, value, ok) => `${ok === undefined ? ' ' : ok ? 'PASS' : 'FAIL'}  ${String(label).padEnd(38)} ${value}`;
  lines.push(`Shake timing evidence — seed ${evidence.seed}, ${evidence.duration.toFixed(2)} s`);
  lines.push('');
  lines.push('Frame-rate feedback (camera transform → envelope / angular velocity)');
  for (const result of evidence.checks.feedback.results) {
    lines.push(row(
      `${result.rate} Hz`,
      `${result.frames} frames · env err ${result.maxEnvelopeError.toExponential(2)} · ω err ${result.maxAngularVelocityError.toExponential(2)}`,
      result.pass,
    ));
  }
  lines.push(row('shared declared times', `Δp ${evidence.checks.feedback.maxSharedPositionError.toExponential(2)} m · Δq ${evidence.checks.feedback.maxSharedRotationError.toExponential(2)} rad`, evidence.checks.feedback.sharedTimesExact));
  lines.push(row('raw samples captured', evidence.sample.raw.reduce((sum, entry) => sum + entry.frames, 0), true));
  lines.push(row('worst envelope row', evidence.evidence.envelope.worst ? `t=${evidence.evidence.envelope.worst.time.toFixed(3)}s err ${evidence.evidence.envelope.worst.error.toExponential(2)}` : 'none', evidence.evidence.envelope.maxError <= 1e-9));
  lines.push(row('worst angular velocity row', evidence.evidence.angularVelocity.worst ? `t=${evidence.evidence.angularVelocity.worst.time.toFixed(3)}s err ${evidence.evidence.angularVelocity.worst.error.toExponential(2)}` : 'none', evidence.evidence.angularVelocity.maxError <= 1e-6));
  lines.push('');
  lines.push('Timeline');
  lines.push(row('pause freezes declared time', `${evidence.checks.pause.pausedAt.toFixed(3)} s`, evidence.checks.pause.frozen));
  lines.push(row('resume advances declared time', evidence.checks.pause.frozen ? 'resumed' : 'blocked', evidence.checks.pause.resumed));
  lines.push(row('old sample runs to end', `state ${evidence.checks.completion.state} · residual ${evidence.checks.completion.endResidualMeters.toExponential(2)} m`, evidence.checks.completion.ok));
  lines.push(row('repeated trigger probes', evidence.checks.repeated.probes.map((p) => `${p.id}@${p.triggeredAt}s`).join(', '), evidence.checks.repeated.ok));
  lines.push('');
  lines.push('Controlled faults (must be detected)');
  lines.push(row('envelope scaled ×0.5', `max err ${evidence.checks.negatives.envelope.maxEnvelopeError.toExponential(2)}`, evidence.checks.negatives.envelope.detected));
  lines.push(row('camera rotation corrupted', `max ω err ${evidence.checks.negatives.angularVelocity.maxAngularVelocityError.toExponential(2)} deg/s`, evidence.checks.negatives.angularVelocity.detected));
  lines.push(row('frame-count timing', `Δp ${evidence.checks.negatives.frameCount.maxSharedPositionError.toExponential(2)} m`, evidence.checks.negatives.frameCount.detected));
  lines.push('');
  lines.push(`Overall: ${evidence.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}
