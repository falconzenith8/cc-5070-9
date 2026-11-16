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

// --- shake timing acceptance (UI is the entry point; CLI is only a helper) ---
await page.evaluate(() => window.__shakeLab.applyPreset('regression'));
await page.waitForTimeout(200);
check('regression sample opens from the demo scene', await page.evaluate(() => {
  const lab = window.__shakeLab;
  return lab.state.preset === 'regression'
    && document.querySelector('[data-preset="regression"]')?.classList.contains('primary');
}));

const beforeTiming = await page.evaluate(() => window.__shakeLab.cameraTransform());
await page.click('#btn-timing');
await page.waitForTimeout(2600);
const timingUi = await page.evaluate(() => {
  const lab = window.__shakeLab;
  const pass = lab.timingPass;
  const summary = document.getElementById('timing-summary').textContent;
  const detail = document.getElementById('timing-detail').textContent;
  const record = lab.captureFeedback({ rate: 24, duration: lab.state.duration });
  const probe = record[20];
  lab.setClockTime(probe.time);
  const cam = lab.cameraTransform();
  const evaluated = lab.evalAt(probe.time).final;
  return {
    pass,
    summary,
    detail,
    cameraMatchesRecord: Math.abs(cam.position.x - probe.position.x) === 0
      && Math.abs(cam.position.y - probe.position.y) === 0
      && Math.abs(cam.quaternion.w - probe.quaternion.w) === 0,
    cameraMatchesRig: Math.abs(cam.position.x - evaluated.position.x) < 1e-12
      && Math.abs(cam.quaternion.w - evaluated.quaternion.w) < 1e-12,
  };
});
check('timing button drives the real camera, not fixed data', timingUi.cameraMatchesRecord
  && timingUi.cameraMatchesRig && beforeTiming !== null, `summary ${timingUi.summary}`);
check('timing panel reports evidence from execution', timingUi.pass === true
  && /pass/.test(timingUi.summary)
  && !/not run/.test(timingUi.detail), timingUi.summary);

const evidence = await page.evaluate(() => {
  const lab = window.__shakeLab;
  lab.pause();
  return lab.timingEvidence({ rates: [24, 60], duration: lab.state.duration });
});
check('envelope and angular velocity come from the raw record', evidence.pass === true
  && evidence.evidence.envelope.rows.length > 0
  && evidence.evidence.angularVelocity.rows.length > 0
  && evidence.evidence.envelope.maxError <= 1e-9
  && evidence.evidence.angularVelocity.maxError <= 1e-6,
  `env ${evidence.evidence.envelope.maxError} · ω ${evidence.evidence.angularVelocity.maxError}`);

check('UI camera transform matches the raw feedback record', await page.evaluate((first) => {
  const lab = window.__shakeLab;
  lab.setClockTime(first.time);
  const cam = lab.cameraTransform();
  return Math.abs(cam.position.x - first.position.x) < 1e-12
    && Math.abs(cam.position.y - first.position.y) < 1e-12
    && Math.abs(cam.quaternion.w - first.quaternion.w) < 1e-12;
}, evidence.sample.raw[0].samples[Math.floor(evidence.sample.raw[0].samples.length / 2)]));

check('frame-count timing is rejected, time-driven capture is accepted', await page.evaluate(() => {
  const lab = window.__shakeLab;
  const good = lab.analyzeFeedback(lab.captureFeedback({ rate: 30, duration: lab.state.duration }));
  const bad = lab.analyzeFeedback(lab.captureFrameCountFeedback({ rate: 24, duration: lab.state.duration }));
  return good.pass === true && bad.pass === false && bad.declaredTimeOk === false;
}));

check('live angular velocity is measured from rendered camera frames', await page.evaluate(() => {
  const lab = window.__shakeLab;
  lab.play();
  return Number.isFinite(lab.angularVelocity);
}));
await page.evaluate(() => window.__shakeLab.pause());

const spectrumMotion = await page.evaluate(() => {
  const lab = window.__shakeLab;
  lab.applyPreset('regression');
  lab.pause();
  lab.setClockTime(1.05);
  const before = {
    camera: lab.cameraTransform().position,
    envelope: lab.evalAt(1.05).envelopeMax,
  };
  const slider = document.getElementById('high-hz');
  slider.value = '28';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  lab.setClockTime(1.05);
  const after = {
    camera: lab.cameraTransform().position,
    envelope: lab.evalAt(1.05).envelopeMax,
  };
  const feedback = lab.analyzeFeedback(lab.captureFeedback({ rate: 60, duration: lab.state.duration }));
  return {
    cameraChanged: Math.hypot(
      after.camera.x - before.camera.x,
      after.camera.y - before.camera.y,
      after.camera.z - before.camera.z,
    ) > 1e-6,
    envelopeUnchanged: before.envelope === after.envelope,
    envelopeStillCorrect: feedback.maxEnvelopeError === 0 && feedback.pass === true,
    errorBanner: document.getElementById('error-banner')?.textContent ?? null,
  };
});
check('spectrum slider changes camera motion while envelope stays reference-correct', spectrumMotion.cameraChanged
  && spectrumMotion.envelopeUnchanged
  && spectrumMotion.envelopeStillCorrect
  && !spectrumMotion.errorBanner, JSON.stringify(spectrumMotion));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
