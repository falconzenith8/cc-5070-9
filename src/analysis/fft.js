/**
 * Small radix-2 FFT with a Hann window. Used by the UI spectrum panel and the
 * Node audit so both display the same measured peaks.
 */
export function fftInPlace(real, imag) {
  const n = real.length;
  if (n !== imag.length || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < len / 2; k++) {
        const uReal = real[i + k];
        const uImag = imag[i + k];
        const vReal = real[i + k + len / 2] * curReal - imag[i + k + len / 2] * curImag;
        const vImag = real[i + k + len / 2] * curImag + imag[i + k + len / 2] * curReal;
        real[i + k] = uReal + vReal;
        imag[i + k] = uImag + vImag;
        real[i + k + len / 2] = uReal - vReal;
        imag[i + k + len / 2] = uImag - vImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

export function nextPowerOfTwo(value) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

function hann(n, i) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
}

/**
 * Spectrum of a uniformly sampled series. Returns one-sided amplitude with
 * the Hann window's coherent gain corrected, so a unit sinusoid peaks at 1.
 */
export function amplitudeSpectrum(samples, { sampleRate, removeMean = true } = {}) {
  if (samples.length < 8) return { frequencies: [], amplitudes: [], sampleRate: sampleRate ?? 0 };
  const rate = sampleRate ?? 1 / (samples[0]?.dt ?? 1 / 120);
  const n = Math.min(nextPowerOfTwo(samples.length), 1 << 16);
  const mean = removeMean ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  let windowSum = 0;
  for (let i = 0; i < n; i++) {
    const w = hann(n, i);
    windowSum += w;
    real[i] = i < samples.length ? (samples[i] - mean) * w : 0;
  }
  fftInPlace(real, imag);
  const frequencies = [];
  const amplitudes = [];
  const scale = 2 / windowSum;
  for (let k = 0; k <= n / 2; k++) {
    frequencies.push((k * rate) / n);
    amplitudes.push(Math.hypot(real[k], imag[k]) * scale);
  }
  return { frequencies, amplitudes, sampleRate: rate, size: n };
}

export function dominantFrequency(samples, sampleRate, { min = 0.3, max = 45 } = {}) {
  const { frequencies, amplitudes } = amplitudeSpectrum(samples, { sampleRate });
  let best = { frequency: 0, amplitude: 0 };
  for (let i = 0; i < frequencies.length; i++) {
    const f = frequencies[i];
    if (f < min || f > max) continue;
    if (amplitudes[i] > best.amplitude) best = { frequency: f, amplitude: amplitudes[i] };
  }
  return best;
}

/** Amplitude in a narrow band around a target frequency. */
export function bandAmplitude(samples, sampleRate, target, tolerance = 0.6) {
  const { frequencies, amplitudes } = amplitudeSpectrum(samples, { sampleRate });
  let peak = 0;
  for (let i = 0; i < frequencies.length; i++) {
    if (Math.abs(frequencies[i] - target) <= tolerance) peak = Math.max(peak, amplitudes[i]);
  }
  return peak;
}


/**
 * Peak frequency refined by parabolic interpolation of the log magnitude.
 * A Hann-windowed bin peak sits within ~0.5 bin of the true tone; fitting the
 * three neighboring bins recovers it to a small fraction of a bin.
 */
export function refinePeak(frequencies, amplitudes, index) {
  if (index <= 0 || index >= frequencies.length - 1) {
    return { frequency: frequencies[index] ?? 0, amplitude: amplitudes[index] ?? 0 };
  }
  const a = Math.log(Math.max(amplitudes[index - 1], 1e-18));
  const b = Math.log(Math.max(amplitudes[index], 1e-18));
  const c = Math.log(Math.max(amplitudes[index + 1], 1e-18));
  const denom = a - 2 * b + c;
  const delta = Math.abs(denom) > 1e-18 ? (0.5 * (a - c)) / denom : 0;
  const bin = frequencies[1] - frequencies[0];
  return {
    frequency: frequencies[index] + delta * bin,
    amplitude: amplitudes[index] * Math.exp(0.25 * (a - c) * delta),
    bin: index,
    offset: delta,
  };
}

export function peakInRange(samples, sampleRate, { min = 0.3, max = 45, interpolate = true } = {}) {
  const spectrum = amplitudeSpectrum(samples, { sampleRate });
  let best = -1;
  for (let i = 0; i < spectrum.frequencies.length; i++) {
    const f = spectrum.frequencies[i];
    if (f < min || f > max) continue;
    if (best < 0 || spectrum.amplitudes[i] > spectrum.amplitudes[best]) best = i;
  }
  if (best < 0) return { frequency: 0, amplitude: 0 };
  return interpolate
    ? refinePeak(spectrum.frequencies, spectrum.amplitudes, best)
    : { frequency: spectrum.frequencies[best], amplitude: spectrum.amplitudes[best] };
}
