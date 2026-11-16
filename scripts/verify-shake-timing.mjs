#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { collectShakeTimingEvidence, formatShakeTiming } from '../src/analysis/shakeTiming.js';

const args = process.argv.slice(2);
const seedArg = args.find((a) => a.startsWith('--seed='));
const outArg = args.find((a) => a.startsWith('--out='));
const seed = seedArg ? Number(seedArg.split('=')[1]) : 4242;
const out = outArg ? outArg.split('=')[1] : null;

if (!Number.isInteger(seed) || seed < 0) {
  console.error('Usage: node scripts/verify-shake-timing.mjs [--seed=4242] [--out=path]');
  process.exit(2);
}

const evidence = collectShakeTimingEvidence({ seed });
console.log(formatShakeTiming(evidence));

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nJSON evidence written to ${out}`);
}
process.exit(evidence.pass ? 0 : 1);
