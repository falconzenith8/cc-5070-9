import { TAU, deriveSeed, mulberry32, smootherstep01 } from './math.js';

export const DEFAULT_SPECTRUM = Object.freeze({ low: 2.2, mid: 7.5, high: 18 });
export const DEFAULT_BAND_GAIN = Object.freeze({ low: 1, mid: 1, high: 1 });
export const NOISE_RATES = Object.freeze({ low: 24, mid: 64, high: 150 });

function hashLattice(seed, salt, index) {
  let h = (seed ^ Math.imul(index | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h ^= h >>> 15;
  h = Math.imul(h ^ IntegerSalt(salt), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

// Integer-only salt folding keeps lattice values stable for a given seed.
function IntegerSalt(salt) {
  let h = 0x811c9dc5;
  const text = String(salt);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Seeded 1D value noise addressed by absolute time. The lattice has no
 * memory, so long runs cannot drift and any sample is reproducible on replay.
 */
class ValueNoise {
  constructor(seed, salt, rate) {
    this.seed = deriveSeed(seed, `noise:${salt}`);
    this.salt = salt;
    this.rate = rate;
  }

  at(time) {
    const position = Math.max(0, time) * this.rate;
    const index = Math.floor(position);
    const fraction = smootherstep01(position - index, 0, 1);
    const a = hashLattice(this.seed, this.salt, index) * 2 - 1;
    const b = hashLattice(this.seed, this.salt, index + 1) * 2 - 1;
    return a + (b - a) * fraction;
  }
}

function phasePair(seed, salt) {
  const random = mulberry32(deriveSeed(seed, `phase:${salt}`));
  return [random() * TAU, random() * TAU];
}

export class SeededOscillatorBank {
  constructor({ seed = 1 } = {}) {
    this.seed = Math.floor(Number(seed) || 0);
    this.spectrum = { ...DEFAULT_SPECTRUM };
    this.bandGain = { ...DEFAULT_BAND_GAIN };
    this.phaseSeedOffset = 0;
    this.rebuild();
  }

  setSpectrum(spectrum = {}, bandGain = {}) {
    this.spectrum = {
      low: Math.max(0.05, Number(spectrum.low) || DEFAULT_SPECTRUM.low),
      mid: Math.max(0.05, Number(spectrum.mid) || DEFAULT_SPECTRUM.mid),
      high: Math.max(0.05, Number(spectrum.high) || DEFAULT_SPECTRUM.high),
    };
    this.bandGain = {
      low: Math.max(0, Number(bandGain.low ?? 1)),
      mid: Math.max(0, Number(bandGain.mid ?? 1)),
      high: Math.max(0, Number(bandGain.high ?? 1)),
    };
    this.rebuild();
    return this;
  }

  setSeed(seed, phaseSeedOffset = 0) {
    this.seed = Math.floor(Number(seed) || 0);
    this.phaseSeedOffset = phaseSeedOffset;
    this.rebuild();
    return this;
  }

  rebuild() {
    const s = this.seed;
    const f = this.spectrum;
    const seed = deriveSeed(s, `osc:${this.phaseSeedOffset}`);
    this.phases = {
      lowA: phasePair(seed, 'lowA'),
      lowB: phasePair(seed, 'lowB'),
      midA: phasePair(seed, 'midA'),
      midB: phasePair(seed, 'midB'),
      highA: phasePair(seed, 'highA'),
      highB: phasePair(seed, 'highB'),
    };
    // The overtone sits well above the fundamental and carries less weight,
    // so the commanded frequency stays the spectral peak of each band.
    this.frequencies = {
      low: f.low,
      low2: Math.max(0.3, f.low * 2.35),
      mid: f.mid,
      mid2: Math.max(0.4, f.mid * 2.15),
      high: f.high,
      high2: Math.max(0.5, f.high * 1.9),
    };
    this.noise = {
      low: new ValueNoise(seed, 'low', NOISE_RATES.low),
      mid: new ValueNoise(seed, 'mid', NOISE_RATES.mid),
      high: new ValueNoise(seed, 'high', NOISE_RATES.high),
    };
    return this;
  }

  /** Band values are bounded roughly to [-1.4, 1.4]; no state is accumulated. */
  sample(time) {
    const t = Math.max(0, time);
    const f = this.frequencies;
    const p = this.phases;
    const n = this.noise;
    const g = this.bandGain;
    const band = (key) => {
      const a = Math.sin(TAU * f[key] * t + p[`${key}A`][0]);
      const b = Math.sin(TAU * f[`${key}2`] * t + p[`${key}B`][1]) * 0.26;
      const noise = n[key].at(t) * 0.42;
      return ((a + b) * 0.7 + noise) * g[key];
    };
    return {
      low: band('low'),
      mid: band('mid'),
      high: band('high'),
    };
  }
}
