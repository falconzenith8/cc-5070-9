export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function rms(values) {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce((a, b) => a + b * b, 0) / values.length);
}

export function peak(values) {
  let max = 0;
  let index = 0;
  values.forEach((v, i) => {
    const a = Math.abs(v);
    if (a > max) {
      max = a;
      index = i;
    }
  });
  return { value: values[index] ?? 0, magnitude: max, index };
}

export function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

/** Largest absolute sample-to-sample step, used to expose envelope joins. */
export function maxStep(values, dt) {
  let max = 0;
  let index = 0;
  for (let i = 1; i < values.length; i++) {
    const step = Math.abs(values[i] - values[i - 1]);
    if (step > max) {
      max = step;
      index = i;
    }
  }
  return { value: max, rate: max / dt, index };
}

export function positionOf(sample) {
  return [sample.position.x, sample.position.y, sample.position.z];
}

export function shakeTranslationOf(sample) {
  return [
    sample.shakeTranslationWorld.x,
    sample.shakeTranslationWorld.y,
    sample.shakeTranslationWorld.z,
  ];
}

export function shakeRotationOf(sample) {
  return [
    sample.shakeRotationDeg.pitch,
    sample.shakeRotationDeg.yaw,
    sample.shakeRotationDeg.roll,
  ];
}

export function translationMagnitude(sample) {
  const t = sample.shakeTranslationWorld;
  return Math.hypot(t.x, t.y, t.z);
}

export function rotationMagnitude(sample) {
  const r = sample.shakeRotationDeg;
  return Math.hypot(r.pitch, r.yaw, r.roll);
}
