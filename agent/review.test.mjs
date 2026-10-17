// Guardrails and the review loop, with the chain, the tool server and the model replaced by fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'foreman-review-'));
Object.assign(process.env, {
  FOREMAN_PLANS_DIR: join(tmp, 'plans'), FOREMAN_LOG_DIR: join(tmp, 'log'),
  FOREMAN_WEB_DATA_DIR: join(tmp, 'web'), FOREMAN_STATE_DIR: join(tmp, 'state'), CHAIN_ID: '31337',
});
const { applyGuardrails, reviewMilestone, alignCriteria, readDecisions, hasDecision, MAX_STEPS } = await import('./review.mjs');
const { normalizePlan, savePlan } = await import('./plan.mjs');
const { canonicalHash } = await import('./canonical.mjs');

const CRITERIA = ['PR is merged', 'README mentions setup'];
const base = { amount: 500_000n, autoApproveCap: 1_000_000n, remainingToday: 5_000_000n, revisions: 0, windowLeft: 86_400, evidenceCount: 2 };
const decision = (over = {}) => ({
  verdict: 'approve', rationale: 'looks right', feedbackToFreelancer: '',
  criteria: CRITERIA.map((criterion) => ({ criterion, met: true, evidence: 'seen' })), ...over,
});
const run = (d, ctx = {}) => applyGuardrails({ decision: d, planCriteria: CRITERIA, ctx: { ...base, ...ctx } });

test('a clean approval passes untouched', () => {
  const r = run(decision());
  assert.equal(r.verdict, 'approve');
  assert.deepEqual(r.guardrails, []);
});

test('approve above the auto-approve cap becomes escalate', () => {
  const r = run(decision(), { amount: 2_000_000n });
  assert.equal(r.verdict, 'escalate');
  assert.match(r.guardrails[0], /^over_auto_approve_cap: approve -> escalate/);
  assert.equal(r.modelVerdict, 'approve');
});

test('approve above the remaining daily allowance becomes escalate', () => {
  assert.equal(run(decision(), { remainingToday: 100n }).verdict, 'escalate');
});

test('approve with an unmet criterion is downgraded to a revision with feedback', () => {
  const d = decision({ criteria: [{ criterion: CRITERIA[0], met: true, evidence: 'merged' }, { criterion: CRITERIA[1], met: false, evidence: 'README has no setup section' }] });
  const r = run(d);
  assert.equal(r.verdict, 'request_revision');
  assert.match(r.feedbackToFreelancer, /README mentions setup/);
  assert.ok(r.feedbackToFreelancer.length <= 500);
});

test('a downgrade at the revision limit escalates instead', () => {
  const d = decision({ criteria: [{ criterion: CRITERIA[0], met: false, evidence: 'x' }, { criterion: CRITERIA[1], met: true, evidence: 'y' }] });
  const r = run(d, { revisions: 3 });
  assert.equal(r.verdict, 'escalate');
  assert.equal(r.guardrails.length, 2);
});

test('request_revision at the revision limit escalates', () => {
  assert.equal(run(decision({ verdict: 'request_revision', feedbackToFreelancer: 'fix' }), { revisions: 3 }).verdict, 'escalate');
});

test('approve without any evidence escalates', () => {
  assert.equal(run(decision(), { evidenceCount: 0 }).verdict, 'escalate');
});

test('a closing review window forces escalation for every verdict', () => {
  assert.equal(run(decision(), { windowLeft: 599 }).verdict, 'escalate');
  assert.equal(run(decision({ verdict: 'request_revision', feedbackToFreelancer: 'f' }), { windowLeft: 10 }).verdict, 'escalate');
});

test('feedback is capped at 500 chars and dropped for non-revisions', () => {
  assert.equal(run(decision({ verdict: 'request_revision', feedbackToFreelancer: 'x'.repeat(900) })).feedbackToFreelancer.length, 500);
  assert.equal(run(decision({ feedbackToFreelancer: 'ignored' })).feedbackToFreelancer, '');
});

test('criteria are pinned to the plan: reordered text matches, missing ones count as unmet', () => {
  const given = [{ criterion: ` ${CRITERIA[1].toUpperCase()} `, met: true, evidence: 'ok' }];
  const out = alignCriteria(CRITERIA, given);
  assert.deepEqual(out.map((c) => [c.criterion, c.met]), [[CRITERIA[0], false], [CRITERIA[1], true]]);
});

// ---------------------------------------------------------------- full loop

function world({ llmScript, tools, policy = {}, milestone = {} }) {
  const plan = savePlan({
    brief: 'b', budgetUSDC: 5, capUnits: 1_000_000n,
    plan: normalizePlan({ title: 'T', summary: 's', reasoning: 'r', reviewPeriodHours: 48, risks: [],
      milestones: [{ name: 'M1', deliverable: 'PR', acceptanceCriteria: CRITERIA, amountUSDC: 0.5, deadlineDays: 7 }] }, { budgetUSDC: 5 }),
  });
  const sent = [];
  const ms = { index: 0, amount: 500_000n, deadline: 9e9, submittedAt: 1000, status: 1, statusName: 'Submitted', revisions: 0, ...milestone };
  const chain = {
    readPolicy: async () => ({ address: '0x1', autoApproveCap: 1_000_000n, dailyCap: 9e6, paused: false, spentToday: 0n, remainingToday: 5_000_000n, ...policy }),
    isManaged: async () => true,
    readJob: async () => ({ jobId: 1, reviewPeriod: 172_800, termsHash: plan.termsHash }),
    readMilestones: async () => [ms],
    submittedNote: async () => 'done: https://github.com/o/r/pull/1',
    chainNow: async () => 2000,
    agentApprove: async (...a) => { sent.push(['approve', ...a]); return { hash: '0xaa', url: 'u' }; },
    agentRequestRevision: async (...a) => { sent.push(['revision', ...a]); return { hash: '0xbb', url: 'u' }; },
    agentEscalate: async (...a) => { sent.push(['escalate', ...a]); return { hash: '0xcc', url: 'u' }; },
  };
  const calls = [];
  const llm = async ({ prompt }) => { calls.push(prompt); return llmScript.shift()?.(prompt) ?? Promise.reject(new Error('script exhausted')); };
  return { deps: { chain, tools, llm }, sent, calls, plan };
}

const fakeTools = (over = {}) => ({
  catalog: async () => [{ name: 'github', price: 2000n, description: 'gh', params: { url: 'string' } }, { name: 'http-check', price: 1000n, description: 'http', params: {} }],
  budget: async () => ({ remaining: 50_000n }),
  call: async (name) => ({ result: { title: 'Fix', state: 'closed', files: [], additions: 3, deletions: 1 }, receipt: { channelId: '0x1', cumulative: '2000', price: '2000' }, priceUnits: 2000n }),
  ...over,
});
const callTool = (name, args) => async () => ({ thought: `check ${name}`, next: 'call_tool', tool: { name, args }, decision: null });
const decide = (d) => async () => ({ thought: 'enough', next: 'decide', tool: null, decision: d });

test('loop: gathers evidence, approves, records a verifiable decision and sends the approval', async () => {
  const w = world({ tools: fakeTools(), llmScript: [callTool('github', { url: 'https://github.com/o/r/pull/1' }), decide(decision())] });
  const res = await reviewMilestone({ jobId: 1, index: 0, deps: w.deps });
  assert.equal(res.record.verdict, 'approve');
  assert.equal(res.record.toolSpendUnits, '2000');
  assert.equal(res.record.steps.length, 2);
  assert.equal(res.record.steps[0].tool, 'github');
  assert.match(res.record.steps[0].resultHash, /^0x[0-9a-f]{64}$/);
  assert.equal(res.reasonHash, canonicalHash(res.record));
  assert.deepEqual(w.sent, [['approve', 1, 0, res.reasonHash]]);
  assert.match(w.calls[1], /step 2 of 6/);
  assert.match(w.calls[1], /"title":"Fix"/); // evidence reaches the next prompt
  assert.ok(w.calls[0].includes('1. PR is merged')); // acceptance criteria verbatim
  // logged and hash-checkable from disk
  const [logged] = readDecisions();
  assert.equal(canonicalHash(logged.record), logged.reasonHash);
  assert.equal(JSON.parse(readFileSync(join(tmp, 'web', 'decisions.json'), 'utf8'))[0].reasonHash, res.reasonHash);
  assert.ok(hasDecision(1, 0, 1000));
});

test('loop: an over-cap approval is escalated by code and the override is in the record', async () => {
  const w = world({ tools: fakeTools(), llmScript: [callTool('http-check', { url: 'https://x' }), decide(decision())], policy: { autoApproveCap: 100_000n } });
  const res = await reviewMilestone({ jobId: 1, index: 0, deps: w.deps });
  assert.equal(res.record.verdict, 'escalate');
  assert.equal(res.record.modelVerdict, 'approve');
  assert.ok(res.record.guardrails.some((g) => g.startsWith('over_auto_approve_cap')));
  assert.equal(w.sent[0][0], 'escalate');
});

test('loop: paused policy aborts before any model call or transaction', async () => {
  const w = world({ tools: fakeTools(), llmScript: [], policy: { paused: true } });
  const res = await reviewMilestone({ jobId: 1, index: 0, deps: w.deps });
  assert.equal(res.aborted, true);
  assert.equal(w.calls.length, 0);
  assert.equal(w.sent.length, 0);
});

test('loop: unreachable tool server still ends in a recorded escalation', async () => {
  const tools = fakeTools({ catalog: async () => { throw new Error('tool server unreachable at http://x'); } });
  const w = world({ tools, llmScript: [decide(decision())] });
  const res = await reviewMilestone({ jobId: 1, index: 0, deps: w.deps });
  assert.equal(res.record.verdict, 'escalate');
  assert.ok(res.record.guardrails.some((g) => g.startsWith('no_evidence')));
  assert.match(w.calls[0], /No tools are available/);
  assert.equal(w.sent[0][0], 'escalate');
});

test('loop: duplicate calls and over-budget calls are refused without paying', async () => {
  let paid = 0;
  const tools = fakeTools({ call: async () => { paid++; return { result: { ok: 1 }, receipt: { channelId: '0x1', cumulative: '1', price: '2000' }, priceUnits: 2000n }; } });
  const w = world({ tools, llmScript: [callTool('github', { url: 'a' }), callTool('github', { url: 'a' }), decide(decision({ verdict: 'escalate', rationale: 'unsure' }))] });
  const res = await reviewMilestone({ jobId: 1, index: 0, deps: w.deps });
  assert.equal(paid, 1);
  assert.ok(res.record.guardrails.some((g) => g.startsWith('duplicate_call_blocked')));
  assert.equal(res.record.toolSpendUnits, '2000');
});

test('loop: a model that never decides is cut off at MAX_STEPS and escalated', async () => {
  const script = Array.from({ length: MAX_STEPS }, (_, i) => callTool('http-check', { url: `https://x/${i}` }));
  const w = world({ tools: fakeTools(), llmScript: script });
  const res = await reviewMilestone({ jobId: 1, index: 0, deps: w.deps });
  assert.equal(res.record.verdict, 'escalate');
  assert.ok(res.record.guardrails.some((g) => /^(max_steps|forced_decision)/.test(g)));
});

test('loop: a model failure escalates instead of crashing', async () => {
  const w = world({ tools: fakeTools(), llmScript: [async () => { throw new Error('claude CLI timed out'); }] });
  const res = await reviewMilestone({ jobId: 1, index: 0, deps: w.deps });
  assert.equal(res.record.verdict, 'escalate');
  assert.ok(res.record.guardrails.some((g) => g.startsWith('llm_unavailable')));
});

test('loop: a plan file that no longer hashes to the on-chain terms is refused', async () => {
  const w = world({ tools: fakeTools(), llmScript: [] });
  w.deps.chain.readJob = async () => ({ jobId: 1, reviewPeriod: 172_800, termsHash: `0x${'11'.repeat(32)}` });
  const res = await reviewMilestone({ jobId: 1, index: 0, deps: w.deps });
  assert.equal(res.aborted, true);
  assert.match(res.reason, /no plan file/);
});
