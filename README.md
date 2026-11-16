# Camera Shake Lab

A runnable procedural camera-shake module and demo scene. Shake events produce
time-enveloped displacement and rotation signals that are added to an authored
base camera pose. The rendered camera transform is composed from named
components, and every sample is a pure function of a declared clock time, seed
and spectrum — no per-frame randomness is accumulated.

## Run the demo

```bash
npm install
npm run dev          # http://localhost:5173
```

Then open the printed URL. The demo starts playing immediately.

Other commands:

```bash
npm test             # 23 node:test checks of the shake core and analysis
node scripts/audit.mjs --seed=1337            # headless trajectory audit (text)
node scripts/audit.mjs --seed=1337 --out=audit.json
npm run build && npm run preview              # production build
npm run test:ui      # browser checks (needs npm run dev in another terminal)
```

## What the interface does

**Left column**

- **Render camera** — a real `THREE.PerspectiveCamera` driven by the final
  composition. The world is entirely static: nothing in the scene moves, so all
  apparent motion is camera motion. Overlaid:
  - *base pose* — the authored, unshaken camera (position + pitch/yaw/roll)
  - *shake add* — the additive offset in the declared space
  - *final pose* — base composed with shake, i.e. exactly what is rendered
  - *base offset* — per-frame `final − base`; it returns to 0 after envelopes close
  - bottom-right inset — chase view showing the base and final camera frustums
    plus the orange offset connector
- **Transport** — Play/Pause, Replay, time scale (0–2×, including slow motion),
  seed, coordinate space (local camera-relative vs. world), and a timeline scrub.
- **Trajectory** — base Y and final Y on the same axis, plus the shake-only
  signal in mm. Switch X/Y/Z with the axis buttons.

**Right column**

- **Shake spectrum** — low/mid/high band frequencies and per-band gains, with
  preset buttons for a single impulse, continuous engine, or both. Every change
  re-evaluates the actual signal. The spectrum plot is the measured amplitude
  spectrum of the current shake, with dashed lines at the commanded frequencies.
- **Event envelopes** — the normalized envelope of each scheduled event with a
  live value in the legend.

**Result area (full width)**

- Six live metrics: peak displacement, peak rotation, peak envelope, current
  base offset, dominant measured frequency, and largest per-frame step.
- **Signal decomposition** — live base / shake / final rows for position and
  rotation, read from the same state used to place the camera.
- **Event results** — each event's start, end, peak displacement, peak envelope,
  and its own contribution at its declared end.
- **Audit** — press *Run trajectory audit* (it also runs on load) to verify the
  impulse, the engine, frame-rate replay at 24/30/60/144 Hz, spectrum tracking,
  and seed reproducibility. Anomalies (for example mid frequency ≥ high
  frequency) are shown in a banner and the rig refuses the invalid schedule.

## Module layout

```
src/shake/
  math.js        clamp/lerp/smootherstep, seed hashing, PRNG
  oscillator.js  seeded, stateless value noise + two-sinusoid band sources
  envelope.js    C1 envelope with exact zero endpoints
  schedule.js    event presets, validation, spectrum normalization
  quaternion.js  YXZ Euler ↔ quaternion, composition
  rig.js         pure evaluator: base pose, shake signal, final pose, residual
  clock.js       declared playback clock (pause / time scale / seek / replay)
src/analysis/
  fft.js         radix-2 FFT, Hann window, parabolic peak refinement
  trajectory.js  RMS, peak, max step helpers
  resample.js    uniform-time resampling of captured trajectories
  audit.js       impulse, engine, frame-rate, spectrum and seed audits
src/scene/       static 3D range and chase-view diagnostic renderer
src/ui/charts.js canvas charts (envelope, trajectory, shake, spectrum)
src/main.js      wiring, render loop, controls, results panel
```

## Design guarantees

- **Explicit frequency, amplitude, seed and space.** Each event declares
  translation (m) and rotation (deg) amplitude, a per-axis weight, band weights,
  a seed offset; the rig declares a global three-band spectrum (Hz + gain) and a
  coordinate space (`local` or `world`). The space is applied consistently:
  - `local`: `finalPosition = basePosition + R(base) · Δp`,
    `finalRotation = R(base) · R(Δθ)`
  - `world`: `finalPosition = basePosition + Δp`,
    `finalRotation = R(Δθ) · R(base)`
- **Frame-rate independence.** Samples depend on absolute declared time, not a
  frame counter. Seeded noise is hash-addressed by time, so replaying at 24, 30,
  60 or 144 Hz gives identical poses at shared times. The audit reports
  `0` max common-time position error; the small trajectory RMS shown is
  interpolation between grid points, not signal drift.
- **Bounded, no drift.** Every oscillator is bounded; no state accumulates. A
  60-second sample run stays below 0.5 m/s and 1 rad of shake.
- **Continuous start/end, exact recovery.** Envelopes are C1 with value and
  slope exactly zero at both endpoints. After the last event ends, the final
  camera equals the base pose (position error and rotation error below 1e-12).
- **Pause, slow motion and replay** all act on one declared clock; they never
  read wall-clock time directly.
- **Real camera motion, not a screen-space effect.** The world is static; the
  camera is the only moving object. The decomposition table and the `__shakeLab`
  test hook expose `base`, `shake` and `final` separately.

## Notes on the display

- The inset is a diagnostic *view* of the rig, not a replacement for camera
  motion; the main viewport is rendered by the composed camera.
- The spectrum chart is computed from the evaluated signal, and its dashed
  markers come from the current slider values, so the visible peak moves when
  the commanded spectrum changes.
