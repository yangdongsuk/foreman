import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUrl, buildPayload, clean, userLog, parseResult } from './attest.mjs';

test('extractUrl takes the first URL and drops trailing punctuation', () => {
  assert.equal(extractUrl('Done, see https://github.com/a/b/pull/1.'), 'https://github.com/a/b/pull/1');
  assert.equal(extractUrl('no link here'), null);
  assert.equal(extractUrl(null), null);
});

test('buildPayload maps plan criteria and on-chain milestone fields', () => {
  const plan = { plan: { milestones: [{ acceptanceCriteria: ['a', 'b'] }] } };
  const p = buildPayload({ jobId: 2, index: 0, plan, milestone: { amount: 50000n, revisions: 1 }, note: 'PR: https://github.com/a/b/pull/1' });
  assert.deepEqual(p, { jobId: 2, index: 0, deliverableUrl: 'https://github.com/a/b/pull/1', criteria: ['a', 'b'], amountUnits: 50000, revisionsUsed: 1 });
  assert.throws(() => buildPayload({ jobId: 2, index: 0, plan, milestone: { amount: 1n, revisions: 0 }, note: 'x' }), /no URL/);
  assert.throws(() => buildPayload({ jobId: 2, index: 3, plan, milestone: { amount: 1n, revisions: 0 }, note: 'https://x.io' }), /no milestone 4/);
});

test('simulator output: strip spinners, read user logs and the result JSON', () => {
  const raw = '\x1b[?25l\x1b[38;2;1;2;3m⣽ \x1b[0m Compiling\x1b[D\r\x1b[2K\r\n'
    + '\x1b[34m2026-10-18T02:01:48Z\x1b[0m \x1b[1m[USER LOG]\x1b[0m Verdict 2 (escalate) via deterministic\r\n'
    + 'Workflow Simulation Result:\r\n"{\\"verdict\\":2,\\"txHash\\":\\"0xab\\"}"\r\n';
  const text = clean(raw);
  assert.equal(userLog(text.split('\n').find((l) => l.includes('USER LOG'))), 'Verdict 2 (escalate) via deterministic');
  assert.deepEqual(parseResult(text), { verdict: 2, txHash: '0xab' });
  assert.equal(parseResult('nothing'), null);
});
