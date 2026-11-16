#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { runAudit } from '../src/analysis/audit.js';

const args = process.argv.slice(2);
const seedArg = args.find((a) => a.startsWith('--seed='));
const outArg = args.find((a) => a.startsWith('--out='));
const seed = seedArg ? Number(seedArg.split('=')[1]) : 1337;
const out = outArg ? outArg.split('=')[1] : null;

if (!Number.isInteger(seed) || seed < 0) {
  console.error('Usage: node scripts/audit.mjs [--seed=1337] [--out=path]');
  process.exit(2);
}

const audit = runAudit({ seed });
const lines = [];
const pad = (s, n) => String(s).padEnd(n);
const row = (label, value, ok) => `${ok === undefined ? ' ' : ok ? 'PASS' : 'FAIL'}  ${pad(label, 34)} ${value}`;

lines.push(`Camera shake audit — seed ${seed}`);
lines.push('');
lines.push('Single impulse');
lines.push(row('peak displacement', `${(audit.impulse.peakMeters * 1000).toFixed(2)} mm / ${audit.impulse.peakDegrees.toFixed(2)} deg`, audit.impulse.peakMeters > 0));
lines.push(row('envelope zero at start/end', `${audit.impulse.boundaries.startBoundary} / ${audit.impulse.boundaries.endBoundary}`, audit.impulse.envelopeStartZero && audit.impulse.envelopeEndZero));
lines.push(row('boundary neighborhood', audit.impulse.boundaries.startNeighborhood.toExponential(2), audit.impulse.boundaries.nearZero));
lines.push(row('residual after end', `${audit.impulse.residualAfterEnd.positionMeters.toExponential(2)} m / ${audit.impulse.residualAfterEnd.rotationRadians.toExponential(2)} rad`, audit.impulse.residualAfterEnd.exact));
lines.push('');
lines.push('Continuous engine');
lines.push(row('steady RMS', `${(audit.engine.steadyRmsMeters * 1000).toFixed(2)} mm`, audit.engine.steadyRmsMeters > 0));
lines.push(row('half-window ratio', audit.engine.stationarityRatio.toFixed(3), Math.abs(audit.engine.stationarityRatio - 1) < 0.15));
lines.push(row('DC offset', `${(audit.engine.dcOffsetMeters * 1000).toFixed(3)} mm`, audit.engine.dcOffsetMeters < audit.engine.steadyRmsMeters * 0.35));
lines.push(row('dominant frequency', `${audit.engine.measuredPeakFrequency.toFixed(2)} Hz`, audit.engine.measuredPeakFrequency <= 4));
lines.push(row('residual after shutdown', audit.engine.residualAfterEnd.positionMeters.toExponential(2), audit.engine.residualAfterEnd.exact));
lines.push('');
lines.push('Frame-rate replay');
lines.push('  rate   exact common-time Δp   trajectory RMS    end residual   common samples');
for (const r of audit.frameRates.results) {
  lines.push(`  ${pad(`${r.rate} Hz`, 6)} ${pad(r.maxCommonPositionError === 0 ? '0' : r.maxCommonPositionError.toExponential(2), 22)} ${pad(`${(r.trajectoryRms * 1000).toFixed(3)} mm`, 17)} ${pad(r.endResidualMeters.toExponential(2), 15)} ${r.commonTimes}`);
}
lines.push(row('all exact at shared times', audit.frameRates.allExactAtCommonTimes ? 'yes' : 'no', audit.frameRates.allExactAtCommonTimes));
lines.push('');
lines.push('Spectrum tracking');
lines.push('  band   commanded   measured   error');
for (const r of audit.spectrum.results) {
  lines.push(`  ${pad(r.band, 6)} ${pad(`${r.commanded.toFixed(2)} Hz`, 11)} ${pad(`${r.measured.toFixed(2)} Hz`, 10)} ${r.errorPercent.toFixed(2)}%`);
}
lines.push(row('spectrum tracking', audit.spectrum.pass ? 'pass' : 'fail', audit.spectrum.pass));
lines.push(row('seed reproducibility', audit.seedCheck.same ? 'identical' : 'differs', audit.seedCheck.pass));
lines.push('');
lines.push(`Overall: ${audit.pass ? 'PASS' : 'FAIL'}`);

const text = lines.join('\n');
console.log(text);
if (out) {
  writeFileSync(out, `${JSON.stringify(audit, null, 2)}\n`);
  console.log(`\nJSON written to ${out}`);
}
process.exit(audit.pass ? 0 : 1);
