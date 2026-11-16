const DPR = () => Math.min(2, window.devicePixelRatio || 1);

export function fitCanvas(canvas) {
  const ratio = DPR();
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

const COLORS = {
  grid: 'rgba(120, 170, 200, 0.12)',
  axis: 'rgba(140, 190, 215, 0.45)',
  line: '#28d7e0',
  lineAlt: '#ffb347',
  envelope: 'rgba(255, 179, 71, 0.85)',
  fill: 'rgba(40, 215, 224, 0.16)',
  cursor: 'rgba(255, 255, 255, 0.65)',
  text: 'rgba(190, 218, 232, 0.78)',
  event: 'rgba(110, 168, 198, 0.5)',
  base: 'rgba(125, 165, 190, 0.75)',
};

function inferDomain(values, { symmetric = true, minSpan = 0.01 } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
  if (symmetric) {
    const span = Math.max(Math.abs(lo), Math.abs(hi), minSpan * 0.5);
    return [-span * 1.12, span * 1.12];
  }
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    return [mid - minSpan / 2, mid + minSpan / 2];
  }
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

function drawGrid(ctx, box, { xTicks = 4, yTicks = 4, xLabel = '', yLabelFormatter = null } = {}) {
  const { left, top, width, height } = box;
  ctx.save();
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= xTicks; i++) {
    const x = left + (width * i) / xTicks;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i++) {
    const y = top + (height * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTimeAxis(ctx, box, duration, cursorTime) {
  const { left, top, width, height } = box;
  ctx.save();
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top + height);
  ctx.lineTo(left + width, top + height);
  ctx.stroke();
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const x = left + (width * i) / 4;
    ctx.fillText(`${((duration * i) / 4).toFixed(1)}s`, x, top + height + 4);
  }
  if (cursorTime != null) {
    const cx = left + (width * Math.min(1, Math.max(0, cursorTime / duration)));
    ctx.strokeStyle = COLORS.cursor;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx, top + height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawSeries(ctx, box, series, domain, color, { fill = false, width = 1.7 } = {}) {
  const { left, top, width: w, height: h } = box;
  const span = domain[1] - domain[0];
  const yOf = (v) => top + h - ((v - domain[0]) / span) * h;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (const s of series) {
    const x = left + w * Math.min(1, Math.max(0, s.time / s.duration));
    const y = yOf(s.value);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  if (fill) {
    const gradient = ctx.createLinearGradient(0, top, 0, top + h);
    gradient.addColorStop(0, 'rgba(40, 215, 224, 0.22)');
    gradient.addColorStop(1, 'rgba(40, 215, 224, 0.02)');
    ctx.fillStyle = gradient;
    ctx.lineTo(left + w, yOf(domain[0]));
    ctx.lineTo(left, yOf(domain[0]));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function eventSpans(ctx, box, duration, events) {
  const { left, top, width, height } = box;
  ctx.save();
  for (const e of events) {
    const x0 = left + width * Math.min(1, Math.max(0, e.start / duration));
    const x1 = left + width * Math.min(1, Math.max(0, (e.start + e.duration) / duration));
    ctx.fillStyle = `rgba(110, 168, 198, 0.10)`;
    ctx.fillRect(x0, top, Math.max(1, x1 - x0), height);
    ctx.strokeStyle = COLORS.event;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, top);
    ctx.lineTo(x0, top + height);
    ctx.moveTo(x1, top);
    ctx.lineTo(x1, top + height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(150, 190, 215, 0.6)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(e.label ?? e.id, x0 + 3, top + 11);
  }
  ctx.restore();
}

/** Envelope panel: one band per event, all drawn on the shared timeline. */
export function drawEnvelopeChart(canvas, { states, duration, cursorTime, events }) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const box = { left: 30, top: 18, width: width - 42, height: height - 46 };
  drawGrid(ctx, box, { xTicks: 4, yTicks: 4 });
  eventSpans(ctx, box, duration, events);

  const seriesFor = (id) => states.map((s) => ({
    time: s.time,
    duration,
    value: s.envelopes.find((e) => e.id === id)?.envelope ?? 0,
  }));
  const colors = ['#28d7e0', '#ffb347', '#8f9dff', '#5ee39a'];
  let index = 0;
  for (const e of events) {
    const series = seriesFor(e.id);
    const domain = [-0.05, 1.15];
    drawSeries(ctx, box, series, domain, colors[index % colors.length], {
      fill: index === 0,
      width: 2,
    });
    index++;
  }

  ctx.save();
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('1.0', 4, box.top - 4);
  ctx.fillText('0.0', 4, box.top + box.height - 10);
  ctx.fillText('envelope', 8, 2);
  ctx.restore();
  drawTimeAxis(ctx, box, duration, cursorTime);
}

/** Translation trace: base position and final position on the same axis. */
export function drawTrajectoryChart(canvas, { states, duration, cursorTime, events, axis = 'y' }) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const box = { left: 46, top: 20, width: width - 60, height: height - 50 };
  drawGrid(ctx, box, { xTicks: 4, yTicks: 4 });
  eventSpans(ctx, box, duration, events);

  const baseValues = states.map((s) => s.base.position[axis]);
  const finalValues = states.map((s) => s.final.position[axis]);
  const domain = inferDomain([...baseValues, ...finalValues], { symmetric: false, minSpan: 0.05 });

  drawSeries(ctx, box, states.map((s) => ({ time: s.time, duration, value: s.base.position[axis] })), domain, COLORS.base, { width: 1.2 });
  drawSeries(ctx, box, states.map((s) => ({ time: s.time, duration, value: s.final.position[axis] })), domain, COLORS.line, { fill: false, width: 1.9 });

  ctx.save();
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = box.top + (box.height * i) / 4;
    const value = domain[1] - ((domain[1] - domain[0]) * i) / 4;
    ctx.fillText(value.toFixed(3), box.left - 6, y);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(40, 215, 224, 0.9)';
  ctx.fillText(`final ${axis.toUpperCase()} (m)`, 8, 2);
  ctx.fillStyle = 'rgba(125, 165, 190, 0.85)';
  ctx.fillText('base', 120, 2);
  ctx.restore();
  drawTimeAxis(ctx, box, duration, cursorTime);
}

/** Shake-only signal: the additive offset returned to zero between events. */
export function drawShakeChart(canvas, { states, duration, cursorTime, events, axis = 'y', space = 'local' }) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const box = { left: 52, top: 20, width: width - 66, height: height - 50 };
  drawGrid(ctx, box, { xTicks: 4, yTicks: 4 });
  eventSpans(ctx, box, duration, events);

  const values = states.map((s) => (space === 'local' ? s.shake.translationLocal : s.shake.translationWorld)[axis] * 1000);
  const domain = inferDomain(values, { symmetric: true, minSpan: 0.01 });
  drawSeries(ctx, box, states.map((s) => ({ time: s.time, duration, value: (space === 'local' ? s.shake.translationLocal : s.shake.translationWorld)[axis] * 1000 })), domain, COLORS.lineAlt, { fill: true, width: 1.6 });

  ctx.save();
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = box.top + (box.height * i) / 4;
    const value = domain[1] - ((domain[1] - domain[0]) * i) / 4;
    ctx.fillText(value.toFixed(2), box.left - 6, y);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 179, 71, 0.92)';
  ctx.fillText(`shake ${space} ${axis.toUpperCase()} (mm)`, 8, 2);
  ctx.restore();
  drawTimeAxis(ctx, box, duration, cursorTime);
}

/** Log-frequency spectrum of the measured shake signal. */
export function drawSpectrumChart(canvas, { spectrum, commanded, cursorFrequency = null, label = 'translation spectrum' }) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const box = { left: 46, top: 20, width: width - 60, height: height - 50 };
  drawGrid(ctx, box, { xTicks: 5, yTicks: 4 });

  const fMin = 0.2;
  const fMax = 60;
  const logMin = Math.log10(fMin);
  const logMax = Math.log10(fMax);
  const xOf = (f) => box.left + ((Math.log10(Math.max(f, fMin)) - logMin) / (logMax - logMin)) * box.width;

  let maxAmp = 1e-12;
  const mags = [];
  for (let i = 0; i < spectrum.frequencies.length; i++) {
    const f = spectrum.frequencies[i];
    if (f < fMin || f > fMax) continue;
    const a = spectrum.amplitudes[i];
    mags.push({ f, a });
    maxAmp = Math.max(maxAmp, a);
  }

  // Area under the spectrum, used for the normalized band readout.
  const total = mags.reduce((sum, m) => sum + m.a, 0) || 1e-12;
  const yOf = (a) => box.top + box.height - (a / (maxAmp * 1.08)) * box.height;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 179, 71, 0.55)';
  ctx.fillStyle = 'rgba(255, 179, 71, 0.16)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  let started = false;
  for (const m of mags) {
    const x = xOf(m.f);
    const y = yOf(m.a);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.lineTo(xOf(fMax), box.top + box.height);
  ctx.lineTo(xOf(fMin), box.top + box.height);
  ctx.closePath();
  ctx.fill();

  if (commanded) {
    for (const [f, color, name] of [
      [commanded.low, '#28d7e0', 'low'],
      [commanded.mid, '#8f9dff', 'mid'],
      [commanded.high, '#5ee39a', 'high'],
    ]) {
      const x = xOf(f);
      ctx.strokeStyle = color;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.top + box.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${name} ${f.toFixed(1)}`, x, box.top + 10);
    }
  }

  if (cursorFrequency) {
    ctx.strokeStyle = COLORS.cursor;
    ctx.beginPath();
    ctx.moveTo(xOf(cursorFrequency), box.top);
    ctx.lineTo(xOf(cursorFrequency), box.top + box.height);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = box.top + (box.height * i) / 4;
    const value = (maxAmp * 1.08) * (1 - i / 4);
    ctx.fillText(value.toFixed(3), box.left - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const f of [0.5, 1, 2, 5, 10, 20, 40]) {
    ctx.fillText(f >= 10 ? `${f}` : `${f}`, xOf(f), box.top + box.height + 4);
  }
  ctx.fillText('Hz', box.left + box.width / 2, box.top + box.height + 16);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255, 179, 71, 0.92)';
  ctx.fillText(label, 8, 2);
  ctx.restore();

  return { totalAmplitude: total, peak: maxAmp };
}
