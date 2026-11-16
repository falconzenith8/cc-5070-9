/**
 * Uniform-time resampling of an already-sampled trajectory. This lets a
 * 24/30/60/144 Hz capture be compared on one common grid, and is how tests
 * prove the underlying signal is frame-rate independent.
 */
export function resampleUniform(samples, targetRate, { start = null, end = null } = {}) {
  if (!samples.length) return [];
  const first = start ?? samples[0].time;
  const last = end ?? samples[samples.length - 1].time;
  if (!(last > first)) return [{ time: first, values: [] }];
  const count = Math.max(1, Math.round((last - first) * targetRate));
  const dt = (last - first) / count;
  const out = [];
  let cursor = 0;
  for (let i = 0; i <= count; i++) {
    const time = first + i * dt;
    while (cursor < samples.length - 2 && samples[cursor + 1].time < time) cursor++;
    const a = samples[cursor];
    const b = samples[Math.min(samples.length - 1, cursor + 1)];
    const span = b.time - a.time;
    const f = span > 0 ? (time - a.time) / span : 0;
    const values = a.values.map((v, index) => v + ((b.values[index] ?? v) - v) * f);
    out.push({ time, values, source: f });
  }
  return out;
}

export function extractSeries(samples, accessor) {
  return samples.map((s) => ({ time: s.time, value: accessor(s) }));
}

export function extractVectorSeries(samples, accessor) {
  return samples.map((s) => ({
    time: s.time,
    values: accessor(s),
  }));
}
