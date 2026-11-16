#!/usr/bin/env node
/**
 * Browser-level checks for the running demo. Requires `npm run dev` (or a
 * preview server) and Chromium for Playwright. Set SHAKE_LAB_URL to point at a
 * different server; defaults to http://localhost:5173/.
 */
import { chromium } from 'playwright';

const BASE = process.env.SHAKE_LAB_URL ?? 'http://localhost:5173/';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1240 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

check('app boots without errors', pageErrors.length === 0, pageErrors.join(' | '));
check('audit auto-runs and passes', (await page.textContent('#audit-pill')).includes('pass'));
check('render camera is live', await page.evaluate(() => !!window.__shakeLab?.cameraTransform().position));
check('camera transform is decomposable', await page.evaluate(() => {
  const s = window.__shakeLab.evalAt(1.2);
  const p = s.final.position;
  const expected = {
    x: s.base.position.x + s.shake.translationWorld.x,
    y: s.base.position.y + s.shake.translationWorld.y,
    z: s.base.position.z + s.shake.translationWorld.z,
  };
  return Math.abs(p.x - expected.x) < 1e-12 && Math.abs(p.y - expected.y) < 1e-12 && Math.abs(p.z - expected.z) < 1e-12;
}));

const poseA = await page.evaluate(() => {
  const lab = window.__shakeLab;
  lab.pause();
  lab.setClockTime(1.7);
  return lab.cameraTransform();
});
await page.evaluate(() => { window.__shakeLab.restart(); });
await page.waitForTimeout(400);
const poseB = await page.evaluate(() => {
  const lab = window.__shakeLab;
  lab.pause();
  lab.setClockTime(1.7);
  return lab.cameraTransform();
});
check('replay reproduces the same camera pose', JSON.stringify(poseA) === JSON.stringify(poseB));

const end = await page.evaluate(() => {
  const lab = window.__shakeLab;
  lab.pause();
  lab.setClockTime(lab.state.duration);
  return { cam: lab.cameraTransform(), res: lab.residualAt(lab.state.duration) };
});
check('camera returns to base at end', end.res.exact && end.res.positionError < 1e-12, JSON.stringify(end.res));

const sampled = await page.evaluate(() => {
  const lab = window.__shakeLab;
  lab.applyPreset('combined');
  lab.pause();
  const rates = [24, 30, 60, 144];
  const out = {};
  for (const rate of rates) {
    const frames = [];
    for (let i = 0; i <= Math.round(7.4 * rate); i++) {
      lab.setClockTime(i / rate);
      frames.push({ t: i / rate, p: lab.cameraTransform().position });
    }
    out[rate] = frames;
  }
  return out;
});
let worst = 0;
for (const rate of [24, 30, 60, 144]) {
  for (const f of sampled[rate]) {
    if (Math.abs(f.t * 24 - Math.round(f.t * 24)) > 1e-9) continue;
    const direct = await page.evaluate((t) => window.__shakeLab.evalAt(t).final.position, f.t);
    worst = Math.max(worst, Math.hypot(f.p.x - direct.x, f.p.y - direct.y, f.p.z - direct.z));
  }
}
check('frame rates agree at shared times', worst < 1e-12, `worst Δ ${worst}`);

const spaces = await page.evaluate(() => {
  const lab = window.__shakeLab;
  lab.setSpace('local');
  const local = lab.evalAt(1.4).shake;
  lab.setSpace('world');
  const world = lab.evalAt(1.4).shake;
  return {
    localDiffers: JSON.stringify(local.translationLocal) !== JSON.stringify(local.translationWorld),
    worldSame: JSON.stringify(world.translationLocal) === JSON.stringify(world.translationWorld),
  };
});
check('space is declared and applied', spaces.localDiffers && spaces.worldSame);
await page.evaluate(() => window.__shakeLab.setSpace('local'));

await page.evaluate(() => {
  const mid = document.getElementById('mid-hz');
  mid.value = '16';
  mid.dispatchEvent(new Event('input', { bubbles: true }));
  const hi = document.getElementById('high-hz');
  hi.value = '8';
  hi.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(250);
check('invalid spectrum shows a banner', await page.evaluate(() => !!document.getElementById('error-banner')));
await page.evaluate(() => {
  const mid = document.getElementById('mid-hz');
  mid.value = '7';
  mid.dispatchEvent(new Event('input', { bubbles: true }));
  const hi = document.getElementById('high-hz');
  hi.value = '18';
  hi.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(250);
check('banner clears after correction', await page.evaluate(() => !document.getElementById('error-banner')));

await page.evaluate(() => window.__shakeLab.setSpectrum({ low: 1, mid: 5, high: 30, gainLow: 1, gainMid: 1, gainHigh: 1 }));
await page.waitForTimeout(300);
const auditAfter = await page.evaluate(() => window.__shakeLab.runAudit());
check('audit tracks the changed spectrum', auditAfter.spectrum.pass);

check('no page errors during run', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
