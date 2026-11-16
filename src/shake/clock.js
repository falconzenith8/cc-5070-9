import { clamp } from './math.js';

export const CLOCK_MODES = Object.freeze(['realtime', 'fixed-step']);
export const CLOCK_STATES = Object.freeze(['playing', 'paused', 'ended']);

/**
 * A declared playback clock. Time only advances through an explicit source:
 * `advance(deltaSeconds)` for interactive frame deltas, or `stepFixed()` for
 * deterministic replay. Pause, time scale and replay all act on this one
 * timeline, so camera motion never reads wall-clock time directly.
 */
export class PlaybackClock {
  constructor({ duration = 6, timeScale = 1, mode = 'realtime', fixedStep = 1 / 120 } = {}) {
    this.duration = Math.max(0.1, Number(duration) || 6);
    this.timeScale = clamp(Number(timeScale) || 1, 0, 4);
    this.mode = CLOCK_MODES.includes(mode) ? mode : 'realtime';
    this.fixedStep = Math.max(1 / 2000, Number(fixedStep) || 1 / 120);
    this.time = 0;
    this.state = 'playing';
    this.accumulator = 0;
    this.totalAdvanced = 0;
  }

  setDuration(duration) {
    this.duration = Math.max(0.1, Number(duration) || 6);
    if (this.time > this.duration) this.time = this.duration;
    return this;
  }

  setTimeScale(scale) {
    this.timeScale = clamp(Number(scale) || 0, 0, 4);
    return this;
  }

  pause() {
    if (this.state === 'playing') this.state = 'paused';
    return this;
  }

  play() {
    if (this.state === 'ended') this.time = 0;
    this.state = 'playing';
    return this;
  }

  restart() {
    this.time = 0;
    this.accumulator = 0;
    this.totalAdvanced = 0;
    this.state = 'playing';
    return this;
  }

  seek(time) {
    this.time = clamp(Number(time) || 0, 0, this.duration);
    if (this.state === 'ended' && this.time < this.duration) this.state = 'paused';
    return this;
  }

  /** Advance the declared timeline by a frame delta in seconds. */
  advance(deltaSeconds) {
    const dt = clamp(Number(deltaSeconds) || 0, 0, 0.25);
    if (this.state !== 'playing') return this.time;
    const scaled = dt * this.timeScale;
    this.time = Math.min(this.duration, this.time + scaled);
    this.totalAdvanced += scaled;
    if (this.time >= this.duration) this.state = 'ended';
    return this.time;
  }

  /** Deterministic fixed-step advance, used by audits and replay. */
  stepFixed(steps = 1) {
    if (this.state !== 'playing') return this.time;
    const scaled = this.fixedStep * this.timeScale;
    for (let i = 0; i < steps; i++) {
      this.time = Math.min(this.duration, this.time + scaled);
      if (this.time >= this.duration) {
        this.state = 'ended';
        break;
      }
    }
    return this.time;
  }

  get progress() {
    return this.duration > 0 ? clamp(this.time / this.duration, 0, 1) : 0;
  }
}
