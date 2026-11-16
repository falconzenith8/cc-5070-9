import { clamp } from './math.js';

export const SPACES = Object.freeze(['local', 'world']);
export const EVENT_TYPES = Object.freeze(['impulse', 'sustained']);

export class ShakeValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ShakeValidationError';
    this.field = field;
  }
}

export const DEFAULT_SPECTRUM = Object.freeze({
  low: 2.0,
  mid: 7.0,
  high: 18.0,
  gainLow: 1,
  gainMid: 1,
  gainHigh: 1,
});

const AXIS_TEMPLATES = {
  impulse: {
    translation: { x: 0.78, y: 0.56, z: 0.34 },
    rotation: { pitch: 1.0, yaw: 0.82, roll: 0.6 },
    bands: { low: 0.5, mid: 1.0, high: 0.95 },
  },
  engine: {
    translation: { x: 0.42, y: 1.0, z: 0.28 },
    rotation: { pitch: 0.35, yaw: 0.28, roll: 1.0 },
    bands: { low: 1.0, mid: 0.55, high: 0.18 },
  },
};

function event(overrides) {
  const templateKey = overrides.type === 'sustained' ? 'engine' : 'impulse';
  const base = AXIS_TEMPLATES[templateKey] ?? AXIS_TEMPLATES.impulse;
  return {
    type: 'impulse',
    space: 'local',
    seedOffset: 0,
    translationMeters: 0.05,
    rotationDegrees: 1.5,
    attack: 0.02,
    release: 0.6,
    axes: {
      translation: { ...base.translation },
      rotation: { ...base.rotation },
    },
    bands: { ...base.bands },
    ...overrides,
    axes: {
      translation: { ...base.translation, ...(overrides.axes?.translation ?? {}) },
      rotation: { ...base.rotation, ...(overrides.axes?.rotation ?? {}) },
    },
    bands: { ...base.bands, ...(overrides.bands ?? {}) },
  };
}

export const PRESETS = Object.freeze({
  impulse: {
    label: 'Single impulse',
    hint: 'One short positional/rotational bump with a smooth finite envelope.',
    build: () =>
      event({
        id: 'impulse-a',
        label: 'Impulse',
        type: 'impulse',
        start: 0.55,
        duration: 1.35,
        attack: 0.018,
        release: 0.85,
        translationMeters: 0.075,
        rotationDegrees: 2.2,
        seedOffset: 11,
        space: 'local',
      }),
  },
  engine: {
    label: 'Continuous engine',
    hint: 'Sustained low-frequency rumble with a ramped start and release.',
    build: () =>
      event({
        id: 'engine-a',
        label: 'Engine',
        type: 'sustained',
        start: 0.4,
        duration: 5.2,
        attack: 0.85,
        release: 1.25,
        translationMeters: 0.024,
        rotationDegrees: 0.55,
        seedOffset: 23,
        space: 'local',
      }),
  },
  combined: {
    label: 'Impulse + engine',
    hint: 'Layered events; additive signals share one declared coordinate space.',
    build: () => [
      event({
        id: 'engine-a',
        label: 'Engine',
        type: 'sustained',
        start: 0.25,
        duration: 6.0,
        attack: 1.0,
        release: 1.4,
        translationMeters: 0.018,
        rotationDegrees: 0.4,
        seedOffset: 23,
        space: 'local',
      }),
      event({
        id: 'impulse-a',
        label: 'Impulse A',
        type: 'impulse',
        start: 1.1,
        duration: 1.15,
        attack: 0.02,
        release: 0.75,
        translationMeters: 0.07,
        rotationDegrees: 1.9,
        seedOffset: 11,
        space: 'local',
      }),
      event({
        id: 'impulse-b',
        label: 'Impulse B',
        type: 'impulse',
        start: 4.15,
        duration: 1.0,
        attack: 0.016,
        release: 0.65,
        translationMeters: 0.05,
        rotationDegrees: 1.25,
        seedOffset: 37,
        space: 'local',
      }),
    ],
  },
});

export function buildPreset(name) {
  const preset = PRESETS[name] ?? PRESETS.impulse;
  const built = preset.build();
  return Array.isArray(built) ? built.map((e) => event(e)) : [event(built)];
}

export function validateSpectrum(spectrum) {
  const errors = [];
  const checkFreq = (key, label) => {
    const value = Number(spectrum?.[key]);
    if (!Number.isFinite(value) || value < 0.1 || value > 60) {
      errors.push({ field: key, message: `${label} frequency must be between 0.1 Hz and 60 Hz.` });
    }
  };
  checkFreq('low', 'Low band');
  checkFreq('mid', 'Mid band');
  checkFreq('high', 'High band');
  if (!Number.isFinite(spectrum?.low) || !Number.isFinite(spectrum?.mid) || !Number.isFinite(spectrum?.high)) {
    return errors;
  }
  const ordered = ['low', 'mid', 'high'].map((k) => Number(spectrum[k]));
  if (!(ordered[0] < ordered[1] && ordered[1] < ordered[2])) {
    errors.push({ field: 'spectrum', message: 'Band frequencies must increase: low < mid < high.' });
  }
  ['gainLow', 'gainMid', 'gainHigh'].forEach((key) => {
    const value = Number(spectrum?.[key]);
    if (!Number.isFinite(value) || value < 0 || value > 3) {
      errors.push({ field: key, message: `${key} must be between 0 and 3.` });
    }
  });
  return errors;
}

export function validateEvents(events, space) {
  const errors = [];
  if (!Array.isArray(events) || events.length === 0) {
    errors.push({ field: 'events', message: 'The schedule needs at least one shake event.' });
    return errors;
  }
  if (!SPACES.includes(space)) {
    errors.push({ field: 'space', message: `Coordinate space must be one of ${SPACES.join(', ')}.` });
  }
  const ids = new Set();
  events.forEach((e, index) => {
    const where = `Event ${index + 1}`;
    if (!e || typeof e.id !== 'string') {
      errors.push({ field: 'events', message: `${where} has no id.` });
      return;
    }
    if (ids.has(e.id)) errors.push({ field: 'events', message: `${where} reuses id "${e.id}".` });
    ids.add(e.id);
    if (!EVENT_TYPES.includes(e.type)) errors.push({ field: 'events', message: `${where} type must be impulse or sustained.` });
    if (e.space && !SPACES.includes(e.space)) {
      errors.push({ field: 'space', message: `${where} declares unknown space "${e.space}".` });
    }
    if (!Number.isFinite(e.start) || e.start < 0) {
      errors.push({ field: 'events', message: `${where} start must be a non-negative number.` });
    }
    if (!Number.isFinite(e.duration) || e.duration < 0.05) {
      errors.push({ field: 'events', message: `${where} duration must be at least 0.05 s.` });
    }
    if (!Number.isFinite(e.translationMeters) || e.translationMeters < 0 || e.translationMeters > 2) {
      errors.push({ field: 'amplitude', message: `${where} translation amplitude must be between 0 and 2 m.` });
    }
    if (!Number.isFinite(e.rotationDegrees) || e.rotationDegrees < 0 || e.rotationDegrees > 90) {
      errors.push({ field: 'amplitude', message: `${where} rotation amplitude must be between 0 and 90 deg.` });
    }
    if (!Number.isFinite(e.attack) || e.attack < 0 || !Number.isFinite(e.release) || e.release < 0) {
      errors.push({ field: 'envelope', message: `${where} attack and release must be non-negative.` });
    } else if (e.attack + e.release > e.duration + 1e-9) {
      errors.push({ field: 'envelope', message: `${where} attack + release can not exceed its duration.` });
    }
    if (!Number.isFinite(e.seedOffset) || e.seedOffset < 0) {
      errors.push({ field: 'seed', message: `${where} seed offset must be a non-negative integer.` });
    }
  });
  return errors;
}

export function scheduleSpan(events, tail = 1.25, minimum = 3) {
  let end = 0;
  for (const e of events) end = Math.max(end, (Number(e.start) || 0) + (Number(e.duration) || 0));
  return Math.max(minimum, end + tail);
}

export function validateSeed(seed) {
  const n = Number(seed);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    return [{ field: 'seed', message: 'Random seed must be an integer between 0 and 4294967295.' }];
  }
  return [];
}

export function normalizeSpectrum(spectrum) {
  return {
    low: clamp(Number(spectrum.low), 0.1, 60),
    mid: clamp(Number(spectrum.mid), 0.1, 60),
    high: clamp(Number(spectrum.high), 0.1, 60),
    gainLow: clamp(Number(spectrum.gainLow ?? 1), 0, 3),
    gainMid: clamp(Number(spectrum.gainMid ?? 1), 0, 3),
    gainHigh: clamp(Number(spectrum.gainHigh ?? 1), 0, 3),
  };
}
