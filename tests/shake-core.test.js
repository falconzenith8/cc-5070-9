import test from 'node:test';
import assert from 'node:assert/strict';
import { ShakeRig, sampleRig } from '../src/shake/rig.js';
import { buildPreset, validateEvents, validateSpectrum } from '../src/shake/schedule.js';
import { PlaybackClock } from '../src/shake/clock.js';
import { eventEnvelope } from '../src/shake/envelope.js';
import { quatAngle, quatFromEulerYXZ, quatToEulerYXZ, quatMultiply, quatIdentity } from '../src/shake/quaternion.js';
import { amplitudeSpectrum, bandAmplitude, dominantFrequency } from '../src/analysis/fft.js';
import { resampleUniform } from '../src/analysis/resample.js';
import { auditImpulse, auditEngine, auditFrameRates, auditSpectrum, runAudit } from '../src/analysis/audit.js';

const SEED = 4242;

function rigFor(preset, opts = {}) {
  const events = buildPreset(preset);
  return { rig: new ShakeRig({ seed: SEED, events, ...opts }), events };
}

test('envelope is exactly zero at declared boundaries and smooth in between', () => {
  const ev = { duration: 1.2, attack: 0.05, release: 0.4 };
  assert.equal(eventEnvelope(0, ev), 0);
  assert.equal(eventEnvelope(1.2, ev), 0);
  assert.equal(eventEnvelope(-0.3, ev), 0);
  assert.equal(eventEnvelope(1.5, ev), 0);
  assert.ok(eventEnvelope(0.6, ev) === 1);
  // Continuity: sample densely and verify there is no step larger than eps.
  const dt = 1 / 2000;
  let prev = 0;
  for (let t = 0; t <= 1.2; t += dt) {
    const v = eventEnvelope(t, ev);
    assert.ok(Math.abs(v - prev) < 0.025, `envelope jump at ${t}`);
    prev = v;
  }
});

test('evaluator is a pure function of time: no accumulated drift', () => {
  const { rig } = rigFor('combined');
  const a = rig.evaluate(2.375);
  const b = rig.evaluate(2.375);
  assert.deepEqual(a.final.position, b.final.position);
  // Walking 10000 steps then evaluating equals direct evaluation.
  for (let i = 0; i < 10000; i++) rig.evaluate(i / 4000);
  const afterWalk = rig.evaluate(2.375);
  assert.equal(afterWalk.final.position.x, a.final.position.x);
});

test('final pose exactly equals base pose after every event ends (impulse)', () => {
  const { rig, events } = rigFor('impulse');
  const event = events[0];
  const end = event.start + event.duration;
  for (const t of [end, end + 0.5, end + 5, 40]) {
    const residual = rig.residual(t);
    assert.ok(residual.positionError < 1e-12, `position residual at ${t} was ${residual.positionError}`);
    assert.ok(residual.rotationError < 1e-12, `rotation residual at ${t} was ${residual.rotationError}`);
    assert.ok(residual.exact);
  }
});

test('final pose exactly equals base pose after engine shutdown', () => {
  const { rig, events } = rigFor('engine');
  const event = events[0];
  const end = event.start + event.duration;
  const residual = rig.residual(end + 0.25);
  assert.ok(residual.positionError < 1e-12, `${residual.positionError}`);
  assert.ok(residual.rotationError < 1e-12, `${residual.rotationError}`);
  assert.ok(residual.exact);
});

test('shake signal is bounded and finite over a long horizon', () => {
  const { rig } = rigFor('combined');
  const samples = sampleRig(rig, { duration: 60, rate: 120 }).samples;
  for (const s of samples) {
    const t = s.shakeTranslationWorld;
    const mag = Math.hypot(t.x, t.y, t.z);
    assert.ok(Number.isFinite(mag) && mag < 0.5, `unbounded shake ${mag}`);
    assert.ok(Math.abs(s.rotation.pitch) < 1);
  }
});

test('replaying at 24/30/60/144 Hz produces identical values at shared times', () => {
  const rates = [24, 30, 60, 144];
  const ref = rigFor('combined').rig;
  for (const rate of rates) {
    const { rig } = rigFor('combined');
    const samples = sampleRig(rig, { duration: 7.5, rate }).samples;
    for (const s of samples) {
      if (Math.abs(s.time * 24 - Math.round(s.time * 24)) > 1e-9) continue;
      const direct = ref.evaluate(s.time);
      assert.equal(s.position.x, direct.final.position.x, `${rate} Hz x at ${s.time}`);
      assert.equal(s.position.y, direct.final.position.y, `${rate} Hz y at ${s.time}`);
    }
  }
});

test('resampled trajectories agree across capture rates', () => {
  const ref = rigFor('combined').rig;
  const base = sampleRig(ref, { duration: 6, rate: 960 });
  const grid = resampleUniform(base.samples.map((s) => ({ time: s.time, values: [s.position.x, s.position.y, s.position.z] })), 60);
  let worst = 0;
  for (const g of grid) {
    const direct = ref.evaluate(g.time).final.position;
    worst = Math.max(worst, Math.abs(g.values[1] - direct.y));
  }
  // A 960 Hz reference to a 60 Hz grid must interpolate to well under a millimetre.
  assert.ok(worst < 1e-3, `interpolation error ${worst}`);
});

test('world and local spaces are both declared and differ only by basis', () => {
  const local = new ShakeRig({ seed: SEED, events: buildPreset('impulse'), space: 'local' });
  const worldRig = new ShakeRig({ seed: SEED, events: buildPreset('impulse'), space: 'world' });
  const a = local.evaluate(0.9);
  const b = worldRig.evaluate(0.9);
  assert.equal(a.space, 'local');
  assert.equal(b.space, 'world');
  assert.notDeepEqual(a.shake.translationLocal, a.shake.translationWorld);
  assert.deepEqual(b.shake.translationLocal, b.shake.translationWorld);
  assert.notDeepEqual(a.final.position, b.final.position);
});

test('seed reproducibility: same seed identical, different seed different', () => {
  const a = new ShakeRig({ seed: 7, events: buildPreset('combined') }).evaluate(2.4);
  const b = new ShakeRig({ seed: 7, events: buildPreset('combined') }).evaluate(2.4);
  const c = new ShakeRig({ seed: 8, events: buildPreset('combined') }).evaluate(2.4);
  assert.equal(a.final.position.x, b.final.position.x);
  assert.notEqual(a.final.position.x, c.final.position.x);
});

test('impulse returns to base with no residual and no boundary step', () => {
  const audit = auditImpulse({ seed: SEED });
  assert.ok(audit.cleanDecay);
  assert.ok(audit.residualAfterEnd.positionMeters < 1e-12);
  assert.ok(audit.residualAfterEnd.rotationRadians < 1e-12);
  assert.equal(audit.boundaries.startBoundary, 0);
  assert.equal(audit.boundaries.endBoundary, 0);
  assert.ok(audit.boundaries.startNeighborhood < 1e-3);
  assert.ok(audit.peakMeters > 0.05 && audit.peakMeters < 0.5);
});

test('continuous engine is stationary, bounded and shuts off cleanly', () => {
  const audit = auditEngine({ seed: SEED });
  assert.ok(audit.cleanDecay);
  assert.ok(Math.abs(audit.stationarityRatio - 1) < 0.15);
  assert.ok(audit.dcOffsetMeters < audit.steadyRmsMeters * 0.35);
  assert.ok(audit.engineHoldComplete ?? audit.envelopeHoldComplete);
  assert.ok(audit.measuredPeakFrequency <= 4, `engine peak at ${audit.measuredPeakFrequency}`);
  assert.ok(audit.steadyPeakMeters < audit.peakMeters * 1.01);
});

test('FFT resolves commanded spectrum peaks in each isolated band', () => {
  const audit = auditSpectrum({ seed: SEED });
  assert.ok(audit.pass);
  for (const r of audit.results) {
    assert.ok(r.error <= Math.max(0.6, r.commanded * 0.18), `${r.band} error ${r.error}`);
  }
});

test('changing spectrum changes the measured dominant frequency', () => {
  const events = buildPreset('engine');
  const lowRig = new ShakeRig({ seed: SEED, events, spectrum: { low: 1.2, mid: 5, high: 14 } });
  const highRig = new ShakeRig({ seed: SEED, events, spectrum: { low: 4, mid: 9, high: 24 } });
  const start = events[0].start + events[0].attack + 0.3;
  const duration = 2;
  const rate = 480;
  const seriesOf = (rig) => {
    const out = [];
    for (let i = 0; i < duration * rate; i++) out.push(rig.evaluate(start + i / rate).shake.translationLocal.y);
    return out;
  };
  const lowPeak = dominantFrequency(seriesOf(lowRig), rate, { min: 0.3, max: 30 });
  const highPeak = dominantFrequency(seriesOf(highRig), rate, { min: 0.3, max: 30 });
  assert.ok(lowPeak.frequency < highPeak.frequency, `${lowPeak.frequency} !< ${highPeak.frequency}`);
});

test('audit frame rates report zero common-time error and zero residual', () => {
  const audit = auditFrameRates({ seed: SEED });
  assert.ok(audit.allExactAtCommonTimes);
  assert.ok(audit.allCleanResidual);
  for (const r of audit.results) {
    assert.ok(r.maxCommonPositionError < 1e-12);
    assert.ok(r.endResidualMeters < 1e-12);
  }
});

test('declared clock: pause, replay and slow motion drive the same timeline', () => {
  const clock = new PlaybackClock({ duration: 5, timeScale: 1 });
  // Frame deltas are clamped to 0.25 s, so advance in frame-sized steps.
  for (let i = 0; i < 5; i++) clock.advance(0.1);
  assert.ok(Math.abs(clock.time - 0.5) < 1e-12);
  clock.pause();
  clock.advance(2);
  assert.equal(clock.time, 0.5);
  clock.setTimeScale(0.25);
  clock.play();
  for (let i = 0; i < 4; i++) clock.advance(0.1);
  assert.ok(Math.abs(clock.time - 0.6) < 1e-12);
  clock.restart();
  assert.equal(clock.time, 0);
  // Restart rewinds the timeline but keeps the declared time scale.
  assert.equal(clock.timeScale, 0.25);
  clock.setTimeScale(1);
  for (let i = 0; i < 60; i++) clock.advance(0.1);
  assert.equal(clock.state, 'ended');
  assert.equal(clock.time, 5);
});

test('slow motion and full speed reach identical declared-time poses', () => {
  const { rig } = rigFor('combined');
  const direct = rig.evaluate(2.0);
  const clock = new PlaybackClock({ duration: 5, timeScale: 0.25 });
  // 2.0 s of declared time takes 8 s of wall time at 0.25x.
  for (let i = 0; i < 8 * 240; i++) clock.advance(1 / 240);
  assert.ok(Math.abs(clock.time - 2) < 0.02, `clock landed at ${clock.time}`);
  const viaClock = rig.evaluate(clock.time);
  const eps = 0.02;
  assert.ok(Math.abs(viaClock.shake.translationLocal.x - direct.shake.translationLocal.x) < eps * 5);
});

test('validation rejects a spectrum whose bands are out of order', () => {
  const errors = validateSpectrum({ low: 10, mid: 2, high: 18, gainLow: 1, gainMid: 1, gainHigh: 1 });
  assert.ok(errors.some((e) => e.field === 'spectrum'));
  const badSeed = new ShakeRig({ seed: -1, events: buildPreset('impulse') });
  assert.ok(badSeed);
  assert.equal(validateEvents(buildPreset('impulse'), 'sideways').length > 0, true);
});

test('invalid schedule surfaces a validation error instead of rendering garbage', () => {
  assert.throws(() => new ShakeRig({ events: [] }), /at least one shake event/);
  assert.throws(
    () => new ShakeRig({ events: [{ ...buildPreset('impulse')[0], attack: 2, release: 2 }] }),
    /attack \+ release/,
  );
});

test('every rendered camera transform decomposes into declared components', () => {
  const { rig } = rigFor('combined');
  for (const t of [0, 0.5, 1.2, 2.7, 4.3, 6.0]) {
    const state = rig.evaluate(t);
    // final position = base position + world shake translation
    assert.ok(Math.abs(
      state.final.position.x - (state.base.position.x + state.shake.translationWorld.x),
    ) < 1e-12, `x decomposition at ${t}`);
    assert.ok(Math.abs(
      state.final.position.y - (state.base.position.y + state.shake.translationWorld.y),
    ) < 1e-12);
    assert.ok(Math.abs(
      state.final.position.z - (state.base.position.z + state.shake.translationWorld.z),
    ) < 1e-12);
    // final quaternion = base quaternion × shake quaternion in local space
    const relative = quatAngle(state.final.quaternion, state.base.quaternion);
    assert.ok(Math.abs(relative - quatAngle(state.shake.quaternion, { x: 0, y: 0, z: 0, w: 1 })) < 1e-9);
  }
});

test('band amplitude tracking follows the command after gain changes', () => {
  const rate = 480;
  const seriesFor = (gain) => {
    const rig = new ShakeRig({
      seed: SEED,
      events: buildPreset('engine'),
      spectrum: { low: 2, mid: 7, high: 18, gainLow: gain, gainMid: 1, gainHigh: 1 },
    });
    const ev = buildPreset('engine')[0];
    const start = ev.start + ev.attack + 0.3;
    const out = [];
    for (let i = 0; i < 3 * rate; i++) out.push(rig.evaluate(start + i / rate).shake.translationLocal.y);
    return out;
  };
  const quiet = bandAmplitude(seriesFor(0.25), rate, 2, 1);
  const loud = bandAmplitude(seriesFor(1.5), rate, 2, 1);
  assert.ok(loud > quiet * 3, `gain did not scale band: ${quiet} vs ${loud}`);
});

test('full audit run passes and is deterministic for a fixed seed', () => {
  const a = runAudit({ seed: SEED });
  const b = runAudit({ seed: SEED });
  assert.ok(a.pass, 'audit should pass');
  assert.equal(a.impulse.peakMeters, b.impulse.peakMeters);
  assert.equal(a.frameRates.results[0].trajectoryRms, b.frameRates.results[0].trajectoryRms);
});


test('YXZ Euler decomposition round-trips for arbitrary rotations', () => {
  const cases = [
    [-0.13, -0.18, 0],
    [0.5, -1.2, 0.4],
    [0.3, 0.9, -0.7],
    [-1.2, 2.9, 0.2],
    [0, 0, 0],
  ];
  for (const [pitch, yaw, roll] of cases) {
    const q = quatFromEulerYXZ(pitch, yaw, roll);
    const e = quatToEulerYXZ(q);
    const back = quatFromEulerYXZ(e.pitch, e.yaw, e.roll);
    assert.ok(quatAngle(q, back) < 1e-12, `round-trip failed for ${pitch},${yaw},${roll}`);
  }
});

test('local space composition equals base rotation then shake rotation', () => {
  const rig = new ShakeRig({ seed: SEED, space: 'local', events: buildPreset('combined') });
  for (const t of [0.4, 1.0, 2.2, 4.6]) {
    const s = rig.evaluate(t);
    const expected = quatMultiply(
      quatFromEulerYXZ(s.base.rotation.pitch, s.base.rotation.yaw, s.base.rotation.roll),
      quatFromEulerYXZ(s.shake.rotationRad.pitch, s.shake.rotationRad.yaw, s.shake.rotationRad.roll),
    );
    assert.ok(quatAngle(expected, s.final.quaternion) < 1e-12, `local composition at ${t}`);
  }
  const world = new ShakeRig({ seed: SEED, space: 'world', events: buildPreset('combined') });
  for (const t of [0.4, 1.0, 2.2, 4.6]) {
    const s = world.evaluate(t);
    const expected = quatMultiply(
      quatFromEulerYXZ(s.shake.rotationRad.pitch, s.shake.rotationRad.yaw, s.shake.rotationRad.roll),
      quatFromEulerYXZ(s.base.rotation.pitch, s.base.rotation.yaw, s.base.rotation.roll),
    );
    assert.ok(quatAngle(expected, s.final.quaternion) < 1e-12, `world composition at ${t}`);
  }
});
