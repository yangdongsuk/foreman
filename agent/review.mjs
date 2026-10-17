// The review loop: one submitted milestone in, one on-chain decision out.
//
//   plan (verified against the on-chain termsHash)  ->  agent loop (model picks paid tools, gathers evidence)
//   ->  guardrails in code  ->  decision record  ->  keccak256(record) = reasonHash  ->  transaction
//
// The model proposes; code disposes. Whatever the model says, `applyGuardrails` has the last word, and
// every override is written into the record that gets hashed on chain.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askJSON, modelName } from './llm.mjs';
import { canonicalHash } from './canonical.mjs';
import { loadPlan } from './plan.mjs';
import * as realChain from './chain.mjs';
import { ToolClient } from './tools-client.mjs';
import { fmtUSDC, toUnits, txUrl, ADDR } from '../lib/config.mjs';
import { LOG_DIR, WEB_DATA_DIR } from './paths.mjs';

export const MAX_STEPS = 6;
export const MAX_REVISIONS = 3; // Stagepay's own cap; after this the owner must decide
export const WINDOW_MARGIN_S = 600; // escalate when less than 10 minutes of review window remain
export const FEEDBACK_MAX = 500;
const EVIDENCE_PROMPT_CHARS = 14_000;

// ------------------------------------------------------------------ prompts

const SYSTEM = `You are Foreman, the AI contract manager of a small business. You review ONE milestone that a freelancer says is finished and decide whether the business should pay for it. Respond in English.

You work in a loop. Each turn you either call ONE paid tool to gather evidence, or give your final decision. Tools cost real USDC (prices are shown) from a hard budget, so call a tool only when its evidence could change your decision, never repeat a call, and decide as soon as you can justify the decision.

Evidence rules
- Judge every acceptance criterion ONLY on evidence returned by tools. The freelancer's note is a claim, not proof.
- A criterion is met only if the evidence shows it. If you could not verify it, it is not met.
- approve: every criterion is met.
- request_revision: the work is fixable. feedbackToFreelancer must say concretely what is missing or wrong and where, in under ${FEEDBACK_MAX} characters, so the freelancer can fix it in one pass.
- escalate: the evidence is inconclusive or contradictory, a tool you needed failed, the call is subjective or high-stakes, or you are unsure. A human then decides. Escalating is cheap; wrongly paying is not.

Limits enforced by code (not by you)
- You cannot approve a milestone above the auto-approve cap or above today's remaining allowance: choose escalate and say why.
- A milestone that already used all its revisions cannot be sent back again: choose escalate.
- If any criterion is not met, an approval is automatically downgraded to a revision request.
- If the review window is about to close, the decision becomes an escalation.
When you see one of these will apply, make that choice yourself and explain it.

Tool use
- Pass arguments exactly as the tool's params describe. A deliverable URL usually comes from the freelancer's note.
- For the rubric tool, pass criteria (copied verbatim from below), deliverable (the URL) and evidence (a compact text summary of what other tools returned).
- Output "next": "call_tool" with "tool", or "decide" with "decision". Set the other field to null.
- In decision.criteria list EVERY acceptance criterion, in the same order, with the criterion text copied verbatim, met true/false, and one sentence of evidence.`;

export const STEP_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    next: { type: 'string', enum: ['call_tool', 'decide'] },
    tool: {
      type: ['object', 'null'],
      properties: { name: { type: 'string' }, args: { type: 'object', additionalProperties: true } },
      required: ['name', 'args'],
    },
    decision: {
      type: ['object', 'null'],
      properties: {
        verdict: { type: 'string', enum: ['approve', 'request_revision', 'escalate'] },
        rationale: { type: 'string' },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } },
            required: ['criterion', 'met', 'evidence'],
          },
        },
        feedbackToFreelancer: { type: 'string' },
      },
      required: ['verdict', 'rationale', 'criteria', 'feedbackToFreelancer'],
    },
  },
  required: ['thought', 'next', 'tool', 'decision'],
};

const usd = (units) => `${fmtUSDC(units)} USDC`;

function buildPrompt(s) {
  const { milestone: m, plan, evidence, tools, budget, step, mustDecide, mustDecideWhy } = s;
  const lines = [];
  lines.push(`## Job: ${plan.plan.title}`, plan.plan.summary, '');
  lines.push(`## Milestone ${m.index + 1} of ${plan.plan.milestones.length}: ${m.plan.name}`);
  lines.push(`Deliverable: ${m.plan.deliverable}`);
  lines.push(`Amount: ${usd(m.amount)}   Revisions used: ${m.revisions} of ${MAX_REVISIONS}   Review window left: ${Math.max(0, Math.floor(s.windowLeft / 60))} min`);
  lines.push('', '## Acceptance criteria (verbatim, judge each one)');
  m.plan.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  lines.push('', '## Freelancer submission note', s.note ? `"""${s.note}"""` : '(no note found)');
  lines.push('', '## Policy limits (enforced by the contract)');
  lines.push(`Auto-approve cap: ${usd(s.policy.autoApproveCap)}   Remaining allowance today: ${usd(s.policy.remainingToday)}   This milestone: ${usd(m.amount)}`);
  lines.push('', '## Tools and budget');
  if (tools.length) {
    lines.push(`Tool budget left for this review: ${usd(budget.remaining)}`);
    for (const t of tools) lines.push(`- ${t.name} (${usd(t.price)}): ${t.description} params: ${JSON.stringify(t.params ?? {})}`);
  } else {
    lines.push('No tools are available for this review.');
  }
  lines.push('', `## Evidence so far (${evidence.length} tool result${evidence.length === 1 ? '' : 's'})`);
  if (!evidence.length) lines.push('(none yet)');
  const per = Math.min(4000, Math.max(1200, Math.floor(EVIDENCE_PROMPT_CHARS / Math.max(1, evidence.length))));
  for (const e of evidence) {
    lines.push(`### step ${e.step}: ${e.tool} ${JSON.stringify(e.args)}`);
    lines.push(e.ok ? clip(JSON.stringify(e.result), per) : `FAILED: ${e.error}`);
  }
  lines.push('', `## Your turn (step ${step} of ${MAX_STEPS})`);
  if (mustDecide) lines.push(`You must decide now (${mustDecideWhy}). Set next to "decide".`);
  return lines.join('\n');
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...[truncated ${s.length - n} chars]` : s);

// -------------------------------------------------------------- guardrails

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** Pin the model's per-criterion verdicts to the plan's criteria, verbatim; anything missing counts as unmet. */
export function alignCriteria(planCriteria, given = []) {
  return planCriteria.map((criterion, i) => {
    const hit = given.find((g) => norm(g.criterion) === norm(criterion)) ?? (given.length === planCriteria.length ? given[i] : undefined);
    return hit
      ? { criterion, met: hit.met === true, evidence: String(hit.evidence ?? '').trim() }
      : { criterion, met: false, evidence: 'no verdict returned for this criterion' };
  });
}

/**
 * Code-enforced rules applied to the model's proposed decision. Pure function: same input, same output.
 * ctx: { amount, autoApproveCap, remainingToday, revisions, windowLeft, evidenceCount } (units / seconds)
 * Returns the final decision plus `guardrails`, one human-readable line per override.
 */
export function applyGuardrails({ decision, planCriteria, ctx }) {
  const guardrails = [];
  const criteria = alignCriteria(planCriteria, decision.criteria);
  let verdict = decision.verdict;
  let rationale = String(decision.rationale ?? '').trim();
  let feedback = String(decision.feedbackToFreelancer ?? '').trim();
  const modelVerdict = verdict;

  const move = (rule, to, why) => {
    guardrails.push(`${rule}: ${verdict} -> ${to} (${why})`);
    verdict = to;
  };
  const unmet = criteria.filter((c) => !c.met);

  if (verdict === 'approve' && unmet.length) move('unmet_criteria', 'request_revision', `${unmet.length} of ${criteria.length} criteria not met`);
  if (verdict === 'approve' && ctx.evidenceCount === 0) move('no_evidence', 'escalate', 'no successful tool evidence was gathered');
  if (verdict === 'approve' && BigInt(ctx.amount) > BigInt(ctx.autoApproveCap)) move('over_auto_approve_cap', 'escalate', `${usd(ctx.amount)} exceeds the ${usd(ctx.autoApproveCap)} cap`);
  if (verdict === 'approve' && BigInt(ctx.amount) > BigInt(ctx.remainingToday)) move('over_daily_cap', 'escalate', `${usd(ctx.amount)} exceeds the ${usd(ctx.remainingToday)} left today`);
  if (verdict === 'request_revision' && ctx.revisions >= MAX_REVISIONS) move('revision_limit', 'escalate', `${ctx.revisions} of ${MAX_REVISIONS} revisions already used`);
  if (verdict !== 'escalate' && ctx.windowLeft < WINDOW_MARGIN_S) move('review_window_closing', 'escalate', `${Math.max(0, Math.floor(ctx.windowLeft / 60))} min of the review window left`);

  if (verdict === 'request_revision' && !feedback) {
    feedback = unmet.map((c) => `Not met: ${c.criterion} ${c.evidence}`.trim()).join(' | ') || rationale;
  }
  if (verdict !== 'request_revision') feedback = '';
  feedback = feedback.slice(0, FEEDBACK_MAX);

  if (guardrails.length) rationale = `${rationale} [Guardrail override: ${guardrails.join('; ')}]`;
  return { verdict, modelVerdict, rationale, criteria, feedbackToFreelancer: feedback, guardrails };
}

// ------------------------------------------------------------ result digests

/** One-line, human-readable summary of what a tool returned (the full result is covered by resultHash). */
export function digestResult(tool, r) {
  if (!r || typeof r !== 'object') return clip(String(r), 200);
  if (r.error) return `error: ${clip(String(r.error), 160)}`;
  if (r.kind === 'repo') return `repo ${r.fullName} · ${r.stars ?? 0} stars · README ${(r.readmeExcerpt || '').length ? `${r.readmeExcerpt.length}+ chars` : 'empty'} · last push ${String(r.pushedAt || '?').slice(0, 10)}`;
  if (r.kind === 'pull_request') return `PR "${clip(r.title, 60)}" ${r.merged ? 'merged' : r.state} · +${r.additions ?? 0}/-${r.deletions ?? 0} in ${r.changed_files ?? '?'} files · CI ${r.ci?.state ?? '?'}`;
  if (r.kind === 'commit') return `commit ${String(r.sha).slice(0, 7)} "${clip(String(r.message).split('\n')[0], 60)}" · ${r.files?.length ?? 0} files`;
  if (r.status !== undefined && 'finalUrl' in r) return `HTTP ${r.status}${r.title ? ` "${clip(r.title, 60)}"` : ''} · ${r.bytes ?? '?'} bytes · ${r.ms ?? '?'} ms`;
  if (Array.isArray(r.verdicts)) return `rubric: ${r.verdicts.filter((v) => v.met).length}/${r.verdicts.length} criteria met (${r.method || 'llm'})`;
  return clip(JSON.stringify(r), 200);
}

// ------------------------------------------------------------- decision log

const decisionsFile = () => join(LOG_DIR, 'decisions.jsonl');

export function readDecisions() {
  if (!existsSync(decisionsFile())) return [];
  return readFileSync(decisionsFile(), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

/** A submission is identified by (job, milestone, submittedAt): a resubmission after revision is a new one. */
export const hasDecision = (jobId, index, submittedAt) =>
  readDecisions().some((d) => d.record.jobId === jobId && d.record.index === index && d.record.submittedAt === submittedAt);

export function writeDecision(entry) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(decisionsFile(), `${JSON.stringify(entry)}\n`);
  mkdirSync(WEB_DATA_DIR, { recursive: true });
  writeFileSync(join(WEB_DATA_DIR, 'decisions.json'), JSON.stringify(readDecisions().reverse(), null, 2)); // newest first
}

// --------------------------------------------------------------- the loop

const REVIEW_BUDGET_UNITS = () => toUnits(process.env.REVIEW_BUDGET_USDC || '0.02');

/**
 * Review one Submitted milestone and act on the decision.
 * emit(event) receives progress for the CLI; deps can be swapped for tests.
 * Returns { record, reasonHash, tx, explorer } or { aborted: true, reason } (no transaction sent).
 */
export async function reviewMilestone({
  jobId, index, emit = () => {},
  deps = { chain: realChain, tools: new ToolClient(), llm: askJSON },
}) {
  const { chain, tools, llm } = deps;
  const abort = (reason) => { emit({ type: 'abort', reason }); return { aborted: true, reason }; };

  // 1. Context: policy, job, plan (hash-verified), submission.
  let policy = await chain.readPolicy();
  if (policy.paused) return abort('policy is paused by the owner: the agent takes no action');
  if (!(await chain.isManaged(jobId))) return abort(`job ${jobId} is not managed by this policy`);
  const job = await chain.readJob(jobId);
  const ms = await chain.readMilestones(jobId);
  const ms0 = ms[index];
  if (!ms0) return abort(`job ${jobId} has no milestone ${index}`);
  if (ms0.statusName !== 'Submitted') return abort(`milestone ${index} is ${ms0.statusName}, not Submitted`);
  let planFile;
  try { planFile = loadPlan(job.termsHash); } catch (e) { return abort(`refusing to review: ${e.message}`); }
  const planMs = planFile.plan.milestones[index];
  if (!planMs || planFile.plan.milestones.length !== ms.length || toUnits(planMs.amountUSDC) !== ms0.amount) {
    return abort('refusing to review: the plan does not match the escrowed milestones');
  }
  const note = await chain.submittedNote(jobId, index);
  const milestone = { index, amount: ms0.amount, revisions: ms0.revisions, plan: planMs };
  const now0 = await chain.chainNow();
  emit({ type: 'context', jobId, index, job, milestone, plan: planFile, policy, note, windowLeft: ms0.submittedAt + job.reviewPeriod - now0 });

  // 2. Tools: discover the priced catalog and the budget. Unreachable tools are not fatal.
  let catalog = [];
  let toolsError = null;
  try { catalog = await tools.catalog(); } catch (e) { toolsError = e.message; emit({ type: 'tools_unavailable', error: e.message }); }
  let channelRemaining = 0n;
  if (catalog.length) {
    try { channelRemaining = (await tools.budget()).remaining; } catch (e) { toolsError = e.message; catalog = []; emit({ type: 'tools_unavailable', error: e.message }); }
  }
  const cap = REVIEW_BUDGET_UNITS();
  let spent = 0n;
  // Per-review cap and the channel balance both bind; a paid-but-failed call still counts as spent.
  const budgetLeft = () => { const left = (cap < channelRemaining ? cap : channelRemaining) - spent; return left > 0n ? left : 0n; };
  const affordable = () => catalog.filter((t) => t.price <= budgetLeft());
  if (catalog.length) emit({ type: 'tools', catalog, budget: budgetLeft() });

  // 3. The loop.
  const guardrails = [];
  const evidence = [];
  const steps = [];
  let proposal = null;
  for (let step = 1; step <= MAX_STEPS && !proposal; step++) {
    const options = affordable();
    const last = step === MAX_STEPS;
    const mustDecideWhy = last ? 'final step' : toolsError ? 'tools are unavailable' : options.length === 0 ? 'the tool budget cannot cover any tool' : '';
    const mustDecide = Boolean(mustDecideWhy);
    emit({ type: 'thinking', step });
    let out;
    try {
      out = await llm({
        system: SYSTEM,
        schema: STEP_SCHEMA,
        prompt: buildPrompt({
          milestone, plan: planFile, evidence, tools: options, budget: { remaining: budgetLeft() }, step, mustDecide, mustDecideWhy,
          note, policy, windowLeft: ms0.submittedAt + job.reviewPeriod - now0,
        }),
      });
    } catch (e) {
      guardrails.push(`llm_unavailable: model call failed at step ${step} (${e.message.slice(0, 160)}), escalating`);
      steps.push({ step, thought: `model call failed: ${e.message.slice(0, 200)}`, tool: null, args: null, receipt: null, resultDigest: null });
      emit({ type: 'guardrail', text: guardrails.at(-1) });
      proposal = escalationOf(`The reviewing model was unavailable (${e.message.slice(0, 120)}), so no automated judgment was possible.`);
      break;
    }
    const thought = String(out.thought ?? '').trim();
    emit({ type: 'thought', step, thought, next: out.next });

    if (out.next === 'decide' && out.decision) {
      steps.push({ step, thought, tool: null, args: null, receipt: null, resultDigest: null });
      proposal = out.decision;
      break;
    }

    // call_tool (or a malformed answer, which counts as a wasted step)
    const name = out.tool?.name;
    const args = parseArgs(out.tool?.args);
    const tool = catalog.find((t) => t.name === name);
    const refuse = (rule, why) => {
      guardrails.push(`${rule}: ${name ?? 'no tool'} ${why}`);
      emit({ type: 'guardrail', text: guardrails.at(-1) });
      steps.push({ step, thought, tool: name ?? null, args, receipt: null, resultDigest: `refused: ${why}` });
      evidence.push({ step, tool: name ?? '(none)', args, ok: false, error: `refused by guardrail: ${why}` });
    };
    if (mustDecide) {
      guardrails.push(`forced_decision: reviewer asked for another tool call when a decision was due (${mustDecideWhy}), escalating`);
      emit({ type: 'guardrail', text: guardrails.at(-1) });
      steps.push({ step, thought, tool: null, args: null, receipt: null, resultDigest: null });
      proposal = escalationOf(`The reviewer wanted more evidence but could not get it (${mustDecideWhy}).`);
      break;
    }
    if (!tool) { refuse('unknown_tool', 'is not in the catalog'); continue; }
    if (tool.price > budgetLeft()) { refuse('tool_over_budget', `costs ${usd(tool.price)} but only ${usd(budgetLeft())} is left`); continue; }
    if (steps.some((s) => s.tool === name && sameArgs(s.args, args) && s.receipt)) { refuse('duplicate_call_blocked', 'was already called with these arguments'); continue; }

    emit({ type: 'tool_call', step, name, args, price: tool.price });
    const t0 = Date.now();
    try {
      const r = await tools.call(name, args);
      spent += r.priceUnits;
      const resultHash = canonicalHash(r.result);
      const resultDigest = digestResult(name, r.result);
      evidence.push({ step, tool: name, args, ok: true, result: r.result });
      steps.push({ step, thought, tool: name, args, receipt: r.receipt, resultDigest, resultHash });
      emit({ type: 'tool_result', step, name, ok: !r.result?.error, digest: resultDigest, price: r.priceUnits, receipt: r.receipt, ms: Date.now() - t0, spent });
    } catch (e) {
      if (e.paid) spent += tool.price;
      evidence.push({ step, tool: name, args, ok: false, error: e.message });
      steps.push({ step, thought, tool: name, args, receipt: null, resultDigest: `error: ${e.message.slice(0, 160)}` });
      emit({ type: 'tool_result', step, name, ok: false, digest: e.message, price: e.paid ? tool.price : 0n, ms: Date.now() - t0, spent });
    }
  }
  if (!proposal) {
    guardrails.push(`max_steps: no decision after ${MAX_STEPS} steps, escalating`);
    emit({ type: 'guardrail', text: guardrails.at(-1) });
    proposal = escalationOf(`The reviewer used all ${MAX_STEPS} steps without reaching a decision.`);
  }

  // 4. Guardrails against FRESH chain state: time and allowance may have moved while we were working.
  policy = await chain.readPolicy();
  if (policy.paused) return abort('policy was paused during the review: no transaction sent');
  const fresh = (await chain.readMilestones(jobId))[index];
  if (fresh.statusName !== 'Submitted' || fresh.submittedAt !== ms0.submittedAt) return abort('the milestone changed during the review: no transaction sent');
  const final = applyGuardrails({
    decision: proposal,
    planCriteria: planMs.acceptanceCriteria,
    ctx: {
      amount: ms0.amount, autoApproveCap: policy.autoApproveCap, remainingToday: policy.remainingToday,
      revisions: fresh.revisions, windowLeft: fresh.submittedAt + job.reviewPeriod - (await chain.chainNow()),
      evidenceCount: evidence.filter((e) => e.ok && !e.result?.error).length, // a tool that answered with an error is not evidence
    },
  });
  for (const g of final.guardrails) emit({ type: 'guardrail', text: g });

  // 5. Decision record and its hash. Round-tripping through JSON guarantees the stored record hashes the same.
  const record = JSON.parse(JSON.stringify({
    version: 1,
    jobId, index,
    milestoneName: planMs.name,
    amountUnits: ms0.amount.toString(),
    verdict: final.verdict,
    modelVerdict: final.modelVerdict,
    rationale: final.rationale,
    criteria: final.criteria,
    feedbackToFreelancer: final.feedbackToFreelancer,
    guardrails: [...guardrails, ...final.guardrails],
    steps,
    toolSpendUnits: spent.toString(),
    model: modelName(),
    planHash: job.termsHash,
    submissionNote: note,
    submittedAt: ms0.submittedAt,
    revisionsUsed: fresh.revisions,
    decidedAt: new Date().toISOString(),
  }));
  const reasonHash = canonicalHash(record);
  emit({ type: 'decision', record, reasonHash });

  // 6. Act on chain with the AGENT key; the contract re-checks every limit.
  const send = { approve: () => chain.agentApprove(jobId, index, reasonHash),
    request_revision: () => chain.agentRequestRevision(jobId, index, record.feedbackToFreelancer, reasonHash),
    escalate: () => chain.agentEscalate(jobId, index, reasonHash) }[record.verdict];
  const tx = await send();
  emit({ type: 'tx', verdict: record.verdict, hash: tx.hash, url: tx.url });

  const entry = { record, reasonHash, tx: tx.hash, explorer: tx.url || txUrl(tx.hash), chainId: Number(process.env.CHAIN_ID || 5042), policy: ADDR.POLICY, loggedAt: new Date().toISOString() };
  writeDecision(entry);
  return entry;
}

function escalationOf(reason) {
  return { verdict: 'escalate', rationale: reason, criteria: [], feedbackToFreelancer: '' };
}

function parseArgs(a) {
  if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } }
  return a && typeof a === 'object' ? a : {};
}

const sameArgs = (a, b) => canonicalHash(a ?? {}) === canonicalHash(b ?? {});
