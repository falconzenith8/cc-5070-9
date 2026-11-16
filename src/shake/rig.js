import { degToRad, deriveSeed } from './math.js';
import { SeededOscillatorBank } from './oscillator.js';
import { eventEnvelope, envelopePhase, envelopeRate } from './envelope.js';
import {
  quatFromEulerYXZ,
  quatMultiply,
  quatRotateVector,
  quatAngle,
  quatToEulerYXZ,
} from './quaternion.js';
import { scheduleSpan, normalizeSpectrum, validateEvents, ShakeValidationError } from './schedule.js';

const BAND_KEYS = Object.freeze(['low', 'mid', 'high']);
const AXIS_KEYS = Object.freeze(['x', 'y', 'z']);
const ROT_KEYS = Object.freeze(['pitch', 'yaw', 'roll']);

export const DEFAULT_BASE = Object.freeze({
  position: Object.freeze({ x: 0.6, y: 2.1, z: 6.4 }),
  rotation: Object.freeze({ pitch: -0.13, yaw: -0.18, roll: 0 }),
});

export const DEFAULT_BASE_MOTION = Object.freeze({
  enabled: false,
  radius: 1.1,
  speed: 0.16,
  heightAmplitude: 0.12,
  yawAmplitude: 0.12,
  pitchAmplitude: 0.03,
});

function copyVector(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function zeroVector() {
  return { x: 0, y: 0, z: 0 };
}

function zeroRotation() {
  return { pitch: 0, yaw: 0, roll: 0 };
}

function scaleVector(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function addVectors(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function eventBankSeed(seed, event, index) {
  return deriveSeed(seed, `event:${event.id}:${event.seedOffset ?? 0}:${index}`);
}

/**
 * The camera rig owns three separately reportable pieces:
 *   1. base pose   - the authored framing, optionally drifting on its own curve
 *   2. shake signal - sum of active oscillator events in the declared space
 *   3. final pose  - base composed with the additive shake
 * The evaluator is pure in (time, seed, parameters): no per-frame randomness,
 * no accumulated offsets, so replay at any rate reproduces the same path.
 */
export class ShakeRig {
  constructor({
    seed = 1337,
    spectrum = null,
    events = [],
    space = 'local',
    base = DEFAULT_BASE,
    baseMotion = DEFAULT_BASE_MOTION,
  } = {}) {
    this.seed = Math.floor(Number(seed) || 0);
    this.space = space === 'world' ? 'world' : 'local';
    this.spectrum = normalizeSpectrum(spectrum ?? { low: 2, mid: 7, high: 18 });
    this.base = {
      position: copyVector(base.position ?? DEFAULT_BASE.position),
      rotation: { ...DEFAULT_BASE.rotation, ...(base.rotation ?? {}) },
    };
    this.baseMotion = { ...DEFAULT_BASE_MOTION, ...(baseMotion ?? {}) };
    this.banks = new Map();
    this.events = [];
    this.setEvents(events);
  }

  setBase(position, rotation) {
    this.base = {
      position: copyVector(position),
      rotation: { pitch: rotation.pitch, yaw: rotation.yaw, roll: rotation.roll },
    };
    return this;
  }

  setBaseMotion(motion) {
    this.baseMotion = { ...this.baseMotion, ...motion };
    return this;
  }

  setSpace(space) {
    this.space = space === 'world' ? 'world' : 'local';
    return this;
  }

  setSeed(seed) {
    this.seed = Math.floor(Number(seed) || 0);
    for (const [id, bank] of this.banks) {
      const event = this.events.find((e) => e.id === id);
      if (event) bank.setSeed(eventBankSeed(this.seed, event, event.index));
    }
    return this;
  }

  setSpectrum(spectrum) {
    this.spectrum = normalizeSpectrum(spectrum);
    const gains = {
      low: this.spectrum.gainLow,
      mid: this.spectrum.gainMid,
      high: this.spectrum.gainHigh,
    };
    for (const bank of this.banks.values()) bank.setSpectrum(this.spectrum, gains);
    return this;
  }

  setEvents(events) {
    const list = events ?? [];
    const errors = validateEvents(list, this.space);
    if (errors.length) {
      throw new ShakeValidationError(errors[0].message, errors[0].field);
    }
    // The rig owns the coordinate space; events are evaluated in it consistently.
    this.events = list.map((e, index) => ({ ...e, space: this.space, index }));
    const wanted = new Set(this.events.map((e) => e.id));
    for (const id of [...this.banks.keys()]) if (!wanted.has(id)) this.banks.delete(id);
    const gains = {
      low: this.spectrum.gainLow,
      mid: this.spectrum.gainMid,
      high: this.spectrum.gainHigh,
    };
    for (const event of this.events) {
      let bank = this.banks.get(event.id);
      if (!bank) {
        bank = new SeededOscillatorBank({ seed: eventBankSeed(this.seed, event, event.index) });
        this.banks.set(event.id, bank);
      }
      bank.setSpectrum(this.spectrum, gains);
    }
    this.duration = scheduleSpan(this.events);
    return this;
  }

  /** Authored base camera pose at a time, including optional slow operator drift. */
  baseAt(time) {
    const t = Math.max(0, Number(time) || 0);
    const position = copyVector(this.base.position);
    const rotation = { ...this.base.rotation };
    const m = this.baseMotion;
    if (m.enabled) {
      const phase = t * m.speed * Math.PI * 2;
      position.x += Math.sin(phase) * m.radius;
      position.z += (Math.cos(phase) - 1) * m.radius * 0.65;
      position.y += Math.sin(phase * 2.1) * m.heightAmplitude;
      rotation.yaw += Math.sin(phase) * m.yawAmplitude;
      rotation.pitch += Math.sin(phase * 1.37 + 0.6) * m.pitchAmplitude;
    }
    const quaternion = quatFromEulerYXZ(rotation.pitch, rotation.yaw, rotation.roll);
    return { position, rotation, quaternion };
  }

  /**
   * Dimensionless, seed-addressed values for one event. Multiplying by the
   * envelope and by the event's amplitude happens in evaluate().
   */
  eventSignal(event, localTime) {
    const bank = this.banks.get(event.id);
    if (!bank) throw new ShakeValidationError(`Missing oscillator bank for "${event.id}"`, 'events');
    // A per-event phase offset keeps overlapping events from being identical.
    const bands = bank.sample(Math.max(0, localTime) + (event.seedOffset ?? 0) * 0.173);
    const unitTranslation = zeroVector();
    const unitRotation = zeroRotation();
    for (const key of BAND_KEYS) {
      const value = (bands[key] ?? 0) * (event.bands?.[key] ?? 1);
      for (const axis of AXIS_KEYS) {
        unitTranslation[axis] += value * (event.axes?.translation?.[axis] ?? 0);
      }
      for (const axis of ROT_KEYS) {
        unitRotation[axis] += value * (event.axes?.rotation?.[axis] ?? 0);
      }
    }
    return { bands, unitTranslation, unitRotation };
  }

  contributionAt(event, time) {
    const localTime = time - (event.start ?? 0);
    const env = eventEnvelope(localTime, event);
    const signal = this.eventSignal(event, localTime);
    const translation = scaleVector(signal.unitTranslation, env * event.translationMeters);
    const rotation = {
      pitch: signal.unitRotation.pitch * env * event.rotationDegrees,
      yaw: signal.unitRotation.yaw * env * event.rotationDegrees,
      roll: signal.unitRotation.roll * env * event.rotationDegrees,
    };
    return {
      id: event.id,
      label: event.label ?? event.id,
      type: event.type,
      space: event.space ?? this.space,
      active: env > 0,
      envelope: env,
      phase: envelopePhase(localTime, event),
      envelopeRate: envelopeRate(localTime, event),
      localTime,
      translation,
      rotationDegrees: rotation,
      bands: signal.bands,
    };
  }

  /** Pure evaluation of every named signal component at an absolute time. */
  evaluate(time) {
    const t = Math.max(0, Number(time) || 0);
    const base = this.baseAt(t);
    const translation = zeroVector();
    const rotationDeg = zeroRotation();
    const contributions = [];

    for (const event of this.events) {
      const c = this.contributionAt(event, t);
      translation.x += c.translation.x;
      translation.y += c.translation.y;
      translation.z += c.translation.z;
      rotationDeg.pitch += c.rotationDegrees.pitch;
      rotationDeg.yaw += c.rotationDegrees.yaw;
      rotationDeg.roll += c.rotationDegrees.roll;
      contributions.push(c);
    }

    const rotationRad = {
      pitch: degToRad(rotationDeg.pitch),
      yaw: degToRad(rotationDeg.yaw),
      roll: degToRad(rotationDeg.roll),
    };
    const shakeQuat = quatFromEulerYXZ(rotationRad.pitch, rotationRad.yaw, rotationRad.roll);

    let finalPosition;
    let finalQuat;
    let translationWorld;
    if (this.space === 'local') {
      translationWorld = quatRotateVector(base.quaternion, translation);
      finalPosition = addVectors(base.position, translationWorld);
      finalQuat = quatMultiply(base.quaternion, shakeQuat);
    } else {
      translationWorld = copyVector(translation);
      finalPosition = addVectors(base.position, translation);
      finalQuat = quatMultiply(shakeQuat, base.quaternion);
    }

    const finalRotation = quatToEulerYXZ(finalQuat);
    const envelopeValues = contributions.map((c) => ({ id: c.id, label: c.label, envelope: c.envelope, phase: c.phase }));

    return {
      time: t,
      space: this.space,
      base,
      shake: {
        translationLocal: translation,
        translationWorld,
        rotationRad,
        rotationDeg: rotationDeg,
        quaternion: shakeQuat,
      },
      final: {
        position: finalPosition,
        rotation: finalRotation,
        quaternion: finalQuat,
      },
      contributions,
      envelopes: envelopeValues,
      envelopeMax: envelopeValues.reduce((m, e) => Math.max(m, e.envelope), 0),
      active: envelopeValues.some((e) => e.envelope > 0),
      activeCount: envelopeValues.filter((e) => e.envelope > 0).length,
    };
  }

  /**
   * Offset between the final camera and its base pose at the same declared
   * time. Zero after every event ends, which is the exact-recovery guarantee.
   */
  residual(time) {
    const state = this.evaluate(time);
    const positionError = Math.hypot(
      state.final.position.x - state.base.position.x,
      state.final.position.y - state.base.position.y,
      state.final.position.z - state.base.position.z,
    );
    const rotationError = quatAngle(state.final.quaternion, state.base.quaternion);
    // Exact recovery is reported within floating-point noise: sub-picometre
    // position error and sub-nanoradian rotation error.
    return {
      positionError,
      rotationError,
      translationMagnitude: Math.hypot(
        state.shake.translationWorld.x,
        state.shake.translationWorld.y,
        state.shake.translationWorld.z,
      ),
      exact: positionError < 1e-12 && rotationError < 1e-12,
    };
  }

  /** Last time any envelope is non-zero. */
  get endTime() {
    let end = 0;
    for (const e of this.events) end = Math.max(end, (e.start ?? 0) + e.duration);
    return end;
  }
}

export function sampleRig(rig, { start = 0, duration, rate }) {
  const frames = Math.max(1, Math.round(duration * rate));
  const dt = 1 / rate;
  const samples = [];
  for (let i = 0; i <= frames; i++) {
    const time = start + i * dt;
    const state = rig.evaluate(time);
    samples.push({
      time,
      position: state.final.position,
      rotation: state.final.rotation,
      basePosition: state.base.position,
      baseRotation: state.base.rotation,
      shakeTranslationWorld: state.shake.translationWorld,
      shakeTranslationLocal: state.shake.translationLocal,
      shakeRotationDeg: state.shake.rotationDeg,
      envelope: state.envelopeMax,
      active: state.active,
    });
  }
  return { rate, dt, samples };
}
