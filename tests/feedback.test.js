import test from 'node:test';
import assert from 'node:assert/strict';
import { ShakeRig } from '../src/shake/rig.js';
import { PlaybackClock } from '../src/shake/clock.js';
import { buildPreset } from '../src/shake/schedule.js';
import { quatFromEulerYXZ, quatMultiply } from '../src/shake/quaternion.js';
import {
  analyzeFeedbackRecord,
  analyzeFeedbackSet,
  angularVelocityDegPerSecond,
  captureCameraFeedback,
  compareFeedbackRecords,
  referenceAngularVelocityDegPerSecond,
  referenceEnvelopeAt,
  referenceGlobalEnvelope,
  uniformTimes,
} from '../src/analysis/feedback.js';
import {
  PoseCamera,
  captureFrameCountFeedback,
  collectShakeTimingEvidence,
} from '../src/analysis/shakeTiming.js';

const SEED = 4242;

function regressionRig(options = {}) {
  const events = buildPreset('regression');
  return { rig: new ShakeRig({ seed: SEED, events, ...options }), events };
}

test('independent envelope reference matches the rig envelope on a raw record', () => {
  const { rig, events } = regressionRig();
  const camera = new PoseCamera();
  const times = uniformTimes(rig.duration, 60);
  const record = captureCameraFeedback(camera, rig, times, {});
  const analysis = analyzeFeedbackRecord(record, { events });
  assert.ok(analysis.pass, JSON.stringify({
    envelope: analysis.worstEnvelope,
    angular: analysis.worstAngularVelocity,
  }));
  assert.ok(analysis.maxEnvelopeError <= 1e-9);
  assert.ok(analysis.peakEnvelope > 0.999);
  assert.ok(analysis.peakTranslationMeters > 0.01);
});

test('reference envelope is independently derived: boundaries are exact zero', () => {
  const event = { start: 1, duration: 2, attack: 0.1, release: 0.5 };
  assert.equal(referenceEnvelopeAt(1, event), 0);
  assert.equal(referenceEnvelopeAt(3, event), 0);
  assert.equal(referenceEnvelopeAt(0.5, event), 0);
  assert.equal(referenceEnvelopeAt(2, event), 1);
  assert.ok(referenceGlobalEnvelope(2, [event, { start: 5, duration: 1 }]) === 1);
});

test('angular velocity reference agrees with finite differences of raw camera quaternions', () => {
  const { rig } = regressionRig();
  const camera = new PoseCamera();
  const times = uniformTimes(rig.duration, 144);
  const record = captureCameraFeedback(camera, rig, times, {});
  for (let i = 1; i < record.length; i += 37) {
    const dt = record[i].time - record[i - 1].time;
    const measured = angularVelocityDegPerSecond(record[i - 1].quaternion, record[i].quaternion, dt);
    const reference = referenceAngularVelocityDegPerSecond(
      record[i - 1].shakeRotationDeg,
      record[i].shakeRotationDeg,
      dt,
    );
    assert.ok(Math.abs(measured - reference) < 1e-6, `ω mismatch at ${record[i].time}`);
  }
  const analysis = analyzeFeedbackRecord(record, { events: rig.events });
  assert.ok(analysis.peakAngularVelocityDegPerSecond > 0);
});

test('variable capture rates agree at shared declared times and in the references', () => {
  const { rig } = regressionRig();
  const camera = new PoseCamera();
  const analysis = analyzeFeedbackSet({
    rig,
    camera,
    rates: [24, 30, 60, 144],
    duration: rig.duration,
  });
  assert.ok(analysis.allRateChecksPass);
  assert.ok(analysis.sharedTimesExact, JSON.stringify({
    pos: analysis.maxSharedPositionError,
    rot: analysis.maxSharedRotationError,
  }));
  assert.ok(analysis.maxSharedPositionError < 1e-12);
  assert.ok(analysis.maxSharedRotationError < 1e-12);
  for (const result of analysis.results) {
    assert.ok(result.envelopeOk);
    assert.ok(result.angularVelocityOk);
    assert.ok(result.frames > 100);
  }
});

test('repeated events trigger their own envelope and retrigger identically', () => {
  const { rig, events } = regressionRig();
  const camera = new PoseCamera();
  const impulses = rig.events.filter((e) => e.type === 'impulse');
  assert.ok(impulses.length >= 3);
  for (const event of impulses) {
    const probeTime = event.start + event.attack + 0.3;
    const state = rig.evaluate(probeTime);
    const contribution = state.contributions.find((c) => c.id === event.id);
    assert.ok(contribution.envelope > 0.999, `${event.id} not triggered at ${probeTime}`);
    const window = uniformTimes(event.duration, 120).map((offset) => event.start + offset);
    const record = captureCameraFeedback(camera, rig, window, {});
    const analysis = analyzeFeedbackRecord(record, { events });
    assert.ok(analysis.pass, `${event.id} feedback failed`);
    const ownEnd = rig.evaluate(event.start + event.duration).contributions.find((c) => c.id === event.id);
    assert.ok(Math.hypot(ownEnd.translation.x, ownEnd.translation.y, ownEnd.translation.z) < 1e-12);
  }
  const window = uniformTimes(1, 90).map((offset) => impulses[0].start + offset);
  const first = captureCameraFeedback(camera, rig, window, {});
  const second = captureCameraFeedback(camera, rig, window, {});
  assert.ok(compareFeedbackRecords(first, second).equal);
});

test('negative cases: a corrupted envelope or rotation is rejected, not passed', () => {
  const { rig } = regressionRig();
  const camera = new PoseCamera();
  const times = uniformTimes(rig.duration, 60);
  const events = rig.events;

  const good = analyzeFeedbackRecord(captureCameraFeedback(camera, rig, times, {}), { events });
  assert.ok(good.pass);

  const badEnvelope = analyzeFeedbackRecord(
    captureCameraFeedback(camera, rig, times, { envelopeOf: (state) => state.envelopeMax * 0.5 }),
    { events },
  );
  assert.equal(badEnvelope.pass, false);
  assert.equal(badEnvelope.envelopeOk, false);
  assert.ok(badEnvelope.maxEnvelopeError > 0.4);

  const badRotation = analyzeFeedbackRecord(
    captureCameraFeedback(camera, rig, times, {
      afterPose: (target, { index }) => {
        const q = quatMultiply(target.quaternion, quatFromEulerYXZ(0, index % 2 ? -0.35 : 0.35, 0));
        target.quaternion.set(q.x, q.y, q.z, q.w);
      },
    }),
    { events },
  );
  assert.equal(badRotation.pass, false);
  assert.equal(badRotation.angularVelocityOk, false);
  assert.ok(badRotation.maxAngularVelocityError > 100);
});

test('frame-count timing is recognized as false evidence', () => {
  const { rig } = regressionRig();
  const camera = new PoseCamera();
  const rate = 24;
  const times = uniformTimes(rig.duration, rate);
  const record = captureFrameCountFeedback(camera, rig, times, rate);
  const analysis = analyzeFeedbackRecord(record, { events: rig.events });
  assert.equal(analysis.declaredTimeOk, false);
  assert.equal(analysis.pass, false);
  assert.ok(record.some((sample, index) => Math.abs(sample.evaluatedTime - index / 60) < 1e-12));

  const fast = captureFrameCountFeedback(camera, rig, uniformTimes(rig.duration, 60), 60);
  const slow = captureFrameCountFeedback(camera, rig, uniformTimes(rig.duration, 24), 24);
  const comparison = compareFeedbackRecords(slow, fast);
  assert.equal(comparison.equal, false);
  assert.ok(comparison.maxPositionError > 0.05);
});

test('pause holds declared time and replay reproduces the same raw record', () => {
  const { rig } = regressionRig();
  const camera = new PoseCamera();
  const clock = new PlaybackClock({ duration: rig.duration, timeScale: 1 });
  for (let i = 0; i < 24; i++) clock.advance(0.05);
  const atPause = clock.time;
  clock.pause();
  clock.advance(3);
  assert.equal(clock.time, atPause);
  const pausedRecord = captureCameraFeedback(camera, rig, [clock.time], {});
  clock.play();
  clock.advance(0.05);
  assert.ok(clock.time > atPause);

  clock.restart();
  for (let i = 0; i < 24; i++) clock.advance(0.05);
  const replayRecord = captureCameraFeedback(camera, rig, [clock.time], {});
  assert.ok(compareFeedbackRecords(pausedRecord, replayRecord).equal);
});

test('shake timing evidence is re-derivable from the raw record it ships', () => {
  const evidence = collectShakeTimingEvidence({ seed: SEED, rates: [24, 60] });
  assert.ok(evidence.pass, JSON.stringify(evidence.checks));
  assert.ok(evidence.sample.raw.length === 2);
  assert.ok(evidence.sample.raw.every((entry) => entry.frames === entry.samples.length));

  // Recompute envelope and angular velocity from the raw capture only.
  const events = buildPreset('regression');
  for (const entry of evidence.sample.raw) {
    const analysis = analyzeFeedbackRecord(entry.samples, { events });
    assert.ok(analysis.envelopeOk, `${entry.rate} Hz envelope mismatch from raw`);
    assert.ok(analysis.angularVelocityOk, `${entry.rate} Hz angular mismatch from raw`);
    assert.equal(analysis.maxEnvelopeError, 0);
  }
  assert.ok(evidence.evidence.envelope.rows.length > 0);
  assert.ok(evidence.evidence.angularVelocity.rows.length > 0);
  for (const row of evidence.evidence.envelope.rows) {
    assert.ok(Math.abs(row.envelope - row.reference) <= 1e-9);
  }
});

test('controlled faults in the timing evidence are reported as detected', () => {
  const evidence = collectShakeTimingEvidence({ seed: SEED, rates: [24, 60] });
  const negatives = evidence.checks.negatives;
  assert.ok(negatives.envelope.detected);
  assert.ok(negatives.angularVelocity.detected);
  assert.ok(negatives.frameCount.detected);
  assert.equal(negatives.envelope.reportedPass, false);
  assert.equal(negatives.angularVelocity.reportedPass, false);
  assert.ok(negatives.frameCount.maxSharedPositionError > 0.01);
  assert.ok(evidence.checks.completion.ok);
  assert.ok(evidence.checks.pause.ok);
  assert.ok(evidence.checks.repeated.ok);
});
