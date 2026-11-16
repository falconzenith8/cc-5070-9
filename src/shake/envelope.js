import { smootherstep01, clamp } from './math.js';

export const ENVELOPE_PHASES = Object.freeze(['before', 'attack', 'hold', 'release', 'after']);

/**
 * Event envelope with C1-continuous boundaries. The value and its slope are
 * exactly zero at the declared start and end, which makes schedule joins
 * continuous and guarantees the shake returns to the base pose.
 */
export function eventEnvelope(localTime, { duration, attack, release }) {
  const d = Math.max(Number(duration) || 0, 1e-6);
  if (!(localTime > 0) || localTime >= d) return 0;
  const a = clamp(Number(attack) || 0, 0, d);
  const r = clamp(Number(release) || 0, 0, d - a);
  if (a > 0 && localTime < a) return smootherstep01(localTime / a);
  if (r > 0 && localTime > d - r) return 1 - smootherstep01((localTime - (d - r)) / r);
  return 1;
}

export function envelopePhase(localTime, { duration, attack, release }) {
  if (localTime <= 0) return 'before';
  if (localTime >= duration) return 'after';
  const a = Math.max(0, Number(attack) || 0);
  const r = Math.max(0, Number(release) || 0);
  if (localTime < a) return 'attack';
  if (localTime > duration - r) return 'release';
  return 'hold';
}

export function envelopeRate(localTime, event, epsilon = 1 / 480) {
  const before = eventEnvelope(localTime - epsilon, event);
  const after = eventEnvelope(localTime + epsilon, event);
  return (after - before) / (2 * epsilon);
}
