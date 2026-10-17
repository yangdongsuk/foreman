import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FOREMAN_PLANS_DIR = mkdtempSync(join(tmpdir(), 'foreman-plans-'));
const { normalizePlan, savePlan, loadPlan, cosignRequired, termsHashOf } = await import('./plan.mjs');

const raw = (over = {}) => ({
  title: ' T ', summary: 's', reasoning: 'r', reviewPeriodHours: 0, risks: [' a '],
  milestones: [
    { name: 'One', deliverable: 'd', acceptanceCriteria: ['c1', ' '], amountUSDC: 0.1234567, deadlineDays: 0 },
    { name: 'Two', deliverable: 'd', acceptanceCriteria: ['c2'], amountUSDC: 0.3, deadlineDays: 5 },
  ],
  ...over,
});

test('normalizes amounts, deadlines, review period and criteria', () => {
  const p = normalizePlan(raw(), { budgetUSDC: 1 });
  assert.equal(p.milestones[0].amountUSDC, 0.123457);
  assert.equal(p.milestones[0].deadlineDays, 7); // 0 -> default
  assert.deepEqual(p.milestones[0].acceptanceCriteria, ['c1']);
  assert.equal(p.reviewPeriodHours, 48);
  assert.equal(p.title, 'T');
});

test('rejects a plan over budget, empty, or with a criterion-less milestone', () => {
  assert.throws(() => normalizePlan(raw(), { budgetUSDC: 0.3 }), /over the 0.3 USDC budget/);
  assert.throws(() => normalizePlan(raw({ milestones: [] }), { budgetUSDC: 1 }), /no milestones/);
  const bad = raw(); bad.milestones[1].acceptanceCriteria = [];
  assert.throws(() => normalizePlan(bad, { budgetUSDC: 1 }), /no acceptance criteria/);
  assert.throws(() => normalizePlan(raw({ milestones: Array(21).fill(raw().milestones[0]) }), { budgetUSDC: 100 }), /limit is 20/);
});

test('flags milestones above the auto-approve cap for owner co-sign', () => {
  const p = normalizePlan(raw(), { budgetUSDC: 1 });
  assert.deepEqual(cosignRequired(p, 200_000n), [1]);
  assert.deepEqual(cosignRequired(p, null), []);
});

test('saved plan loads and verifies; a tampered criterion is refused', () => {
  const plan = normalizePlan(raw(), { budgetUSDC: 1 });
  const f = savePlan({ brief: 'brief', plan, budgetUSDC: 1, capUnits: 200_000n });
  assert.equal(loadPlan(f.termsHash).termsHash, f.termsHash);
  const path = join(process.env.FOREMAN_PLANS_DIR, `${f.termsHash}.json`);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  doc.plan.milestones[0].acceptanceCriteria = ['anything goes'];
  writeFileSync(path, JSON.stringify(doc));
  assert.throws(() => loadPlan(f.termsHash), /does not match the on-chain termsHash/);
  assert.notEqual(termsHashOf(doc), f.termsHash);
});
