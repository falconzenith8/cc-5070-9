/**
 * Acceptance for the feedback trajectory.
 *
 * Samples are taken from a real camera transform (not from oscillator
 * internals). The reference envelope and angular velocity below are a second,
 * deliberately simple implementation: they do not import the shake rig, its
 * envelope or its quaternion helpers, so a regressed rig cannot make the
 * expectation agree with the defect by construction.
 */

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function referenceSmootherstep(x) {
  const u = clamp01(x);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

export function referenceEnvelopeAt(time, event) {
  const duration = Math.max(Number(event?.duration) || 0, 1e-6);
  const local = time - (Number(event?.start) || 0);
  if (!(local > 0) || local >= duration) return 0;
  const attack = Math.min(Math.max(Number(event?.attack) || 0, 0), duration);
  const release = Math.min(Math.max(Number(event?.release) || 0, 0), duration - attack);
  if (attack > 0 && local < attack) return referenceSmootherstep(local / attack);
  if (release > 0 && local > duration - release) {
    return 1 - referenceSmootherstep((local - (duration - release)) / release);
  }
  return 1;
}

export function referenceGlobalEnvelope(time, events) {
  let value = 0;
  for (const event of events ?? []) value = Math.max(value, referenceEnvelopeAt(time, event));
  return value;
}

function quaternionFromEulerYXZ({ pitch = 0, yaw = 0, roll = 0 } = {}) {
  const half = Math.PI / 360;
  const hp = Number(pitch) * half;
  const hy = Number(yaw) * half;
  const hr = Number(roll) * half;
  const cx = Math.cos(hp);
  const sx = Math.sin(hp);
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cz = Math.cos(hr);
  const sz = Math.sin(hr);

  const x1 = cy * sx;
  const y1 = sy * cx;
  const z1 = -sy * sx;
  const w1 = cy * cx;

  return {
    x: x1 * cz + y1 * sz,
    y: -x1 * sz + y1 * cz,
    z: w1 * sz + z1 * cz,
    w: w1 * cz - z1 * sz,
  };
}

function quaternionMultiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function quaternionAngle(a, b) {
  const inverse = { x: -a.x, y: -a.y, z: -a.z, w: a.w };
  const relative = quaternionMultiply(inverse, b);
  return 2 * Math.atan2(
    Math.hypot(relative.x, relative.y, relative.z),
    Math.abs(relative.w),
  );
}

function radiansToDegrees(value) {
  return (value * 180) / Math.PI;
}

/** Angular speed between two Euler-recorded shake rotations, in deg/s. */
export function referenceAngularVelocityDegPerSecond(rotA, rotB, dt) {
  if (!(dt > 0) || !rotA || !rotB) return 0;
  const qA = quaternionFromEulerYXZ(rotA);
  const qB = quaternionFromEulerYXZ(rotB);
  return radiansToDegrees(quaternionAngle(qA, qB)) / dt;
}

/** Angular speed between two raw camera quaternions, in deg/s. */
export function angularVelocityDegPerSecond(qA, qB, dt) {
  if (!(dt > 0) || !qA || !qB) return 0;
  return radiansToDegrees(quaternionAngle(qA, qB)) / dt;
}

/**
 * Observe the real camera after the rig pose is applied. `afterPose` and
 * `envelopeOf` exist for controlled-error injection: the acceptance suite uses
 * them to prove that a bad camera transform or a bad envelope feedback is
 * actually detected.
 */
export function captureCameraFeedback(camera, rig, times, {
  afterPose = null,
  envelopeOf = (state) => state.envelopeMax,
} = {}) {
  const record = [];
  for (let index = 0; index < times.length; index++) {
    const time = times[index];
    const state = rig.evaluate(time);
    camera.position.set(
      state.final.position.x,
      state.final.position.y,
      state.final.position.z,
    );
    camera.quaternion.set(
      state.final.quaternion.x,
      state.final.quaternion.y,
      state.final.quaternion.z,
      state.final.quaternion.w,
    );
    if (afterPose) afterPose(camera, { state, time, index });
    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld(true);

    record.push({
      time,
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
      envelope: envelopeOf(state, { time, index }),
      envelopeMax: state.envelopeMax,
      envelopes: state.envelopes.map((entry) => ({ ...entry })),
      active: state.active,
    });
  }
  return record;
}

function maxOf(values) {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max;
}

/**
 * Analyze one raw record. Both the amplitude envelope and the angular velocity
 * are compared sample-by-sample with the independent reference, and the worst
 * rows are returned as execution evidence.
 */
export function analyzeFeedbackRecord(record, {
  events,
  toleranceEnvelope = 1e-9,
  toleranceAngularVelocity = 1e-6,
  minimumPeakEnvelope = 0.5,
} = {}) {
  const rows = [];
  let maxEnvelopeError = 0;
  let maxAngularVelocityError = 0;
  let peakEnvelope = 0;
  let peakTranslationMeters = 0;
  let peakAngularVelocity = 0;
  let worstEnvelope = null;
  let worstAngularVelocity = null;
  let declaredTimeOk = true;

  for (let i = 0; i < record.length; i++) {
    const sample = record[i];
    if (Math.abs(sample.time - sample.evaluatedTime) > 1e-12) declaredTimeOk = false;

    const envelopeReference = events ? referenceGlobalEnvelope(sample.time, events) : null;
    const envelopeError = envelopeReference == null
      ? 0
      : Math.abs(sample.envelope - envelopeReference);

    let angularVelocity = null;
    let angularVelocityReference = null;
    let angularVelocityError = 0;
    if (i > 0) {
      const dt = sample.time - record[i - 1].time;
      angularVelocity = angularVelocityDegPerSecond(record[i - 1].quaternion, sample.quaternion, dt);
      angularVelocityReference = referenceAngularVelocityDegPerSecond(
        record[i - 1].shakeRotationDeg,
        sample.shakeRotationDeg,
        dt,
      );
      angularVelocityError = Math.abs(angularVelocity - angularVelocityReference);
      if (!worstAngularVelocity || angularVelocityError > worstAngularVelocity.error) {
        worstAngularVelocity = {
          index: i,
          time: sample.time,
          computed: angularVelocity,
          reference: angularVelocityReference,
          error: angularVelocityError,
        };
      }
      maxAngularVelocityError = Math.max(maxAngularVelocityError, angularVelocityError);
      peakAngularVelocity = Math.max(peakAngularVelocity, angularVelocity);
    }

    const translation = sample.shakeTranslationWorld;
    const translationMeters = Math.hypot(translation.x, translation.y, translation.z);
    peakTranslationMeters = Math.max(peakTranslationMeters, translationMeters);
    peakEnvelope = Math.max(peakEnvelope, sample.envelope);
    if (!worstEnvelope || envelopeError > worstEnvelope.error) {
      worstEnvelope = {
        index: i,
        time: sample.time,
        computed: sample.envelope,
        reference: envelopeReference,
        error: envelopeError,
      };
    }
    maxEnvelopeError = Math.max(maxEnvelopeError, envelopeError);

    rows.push({
      index: i,
      time: sample.time,
      envelope: sample.envelope,
      envelopeReference,
      envelopeError,
      angularVelocityDegPerSecond: angularVelocity,
      angularVelocityReferenceDegPerSecond: angularVelocityReference,
      angularVelocityError,
      translationMeters,
    });
  }

  const envelopeOk = maxEnvelopeError <= toleranceEnvelope;
  const angularVelocityOk = maxAngularVelocityError <= toleranceAngularVelocity;
  const hasActivity = peakEnvelope >= minimumPeakEnvelope && peakTranslationMeters > 0;
  const hasAngularMotion = peakAngularVelocity > 0;
  const finite = rows.every((row) => Number.isFinite(row.envelope)
    && Number.isFinite(row.envelopeReference)
    && Number.isFinite(row.translationMeters)
    && (row.angularVelocityDegPerSecond == null || Number.isFinite(row.angularVelocityDegPerSecond)));

  return {
    rows,
    samples: record.length,
    maxEnvelopeError,
    maxAngularVelocityError,
    peakEnvelope,
    peakTranslationMeters,
    peakAngularVelocityDegPerSecond: peakAngularVelocity,
    worstEnvelope,
    worstAngularVelocity,
    declaredTimeOk,
    envelopeOk,
    angularVelocityOk,
    hasActivity,
    hasAngularMotion,
    finite,
    pass: rows.length > 1
      && finite
      && declaredTimeOk
      && envelopeOk
      && angularVelocityOk
      && hasActivity
      && hasAngularMotion,
  };
}

/**
 * Compare two raw records at declared times they share. A frame-count-driven
 * sampler fails this; a time-pure sampler passes exactly.
 */
export function compareFeedbackRecords(a, b, { tolerance = 1e-9 } = {}) {
  let maxPositionError = 0;
  let maxRotationError = 0;
  let sharedTimes = 0;
  let j = 0;
  for (const left of a) {
    while (j < b.length && b[j].time < left.time - tolerance) j++;
    if (j >= b.length) break;
    const right = b[j];
    if (Math.abs(right.time - left.time) > tolerance) continue;
    sharedTimes += 1;
    maxPositionError = Math.max(maxPositionError, Math.hypot(
      left.position.x - right.position.x,
      left.position.y - right.position.y,
      left.position.z - right.position.z,
    ));
    maxRotationError = Math.max(maxRotationError, quaternionAngle(left.quaternion, right.quaternion));
  }
  return {
    sharedTimes,
    maxPositionError,
    maxRotationError,
    equal: sharedTimes > 0 && maxPositionError <= tolerance && maxRotationError <= tolerance,
  };
}

export function uniformTimes(duration, rate) {
  const frames = Math.max(1, Math.round(duration * rate));
  const times = [];
  for (let i = 0; i <= frames; i++) times.push(i / rate);
  return times;
}

/**
 * Acceptance across capture rates. Each rate is evaluated into a real camera,
 * analyzed against the references, and compared at shared declared times.
 */
export function analyzeFeedbackSet({
  rig,
  camera,
  rates = [24, 30, 60, 144],
  duration = rig.duration,
  events = rig.events,
  captureOptions = {},
} = {}) {
  const results = rates.map((rate) => {
    const record = captureCameraFeedback(camera, rig, uniformTimes(duration, rate), captureOptions);
    const analysis = analyzeFeedbackRecord(record, { events });
    return { rate, frames: record.length, record, ...analysis };
  });

  let maxSharedPositionError = 0;
  let maxSharedRotationError = 0;
  let sharedPairs = 0;
  for (let i = 0; i < results.length; i++) {
    for (let k = i + 1; k < results.length; k++) {
      const comparison = compareFeedbackRecords(results[i].record, results[k].record);
      if (comparison.sharedTimes > 1) sharedPairs += 1;
      maxSharedPositionError = Math.max(maxSharedPositionError, comparison.maxPositionError);
      maxSharedRotationError = Math.max(maxSharedRotationError, comparison.maxRotationError);
    }
  }

  return {
    rates,
    results,
    sharedPairs,
    maxSharedPositionError,
    maxSharedRotationError,
    allRateChecksPass: results.every((result) => result.pass),
    sharedTimesExact: sharedPairs > 0
      && maxSharedPositionError <= 1e-9
      && maxSharedRotationError <= 1e-9,
    pass: results.every((result) => result.pass)
      && sharedPairs > 0
      && maxSharedPositionError <= 1e-9
      && maxSharedRotationError <= 1e-9,
  };
}
