// Brief -> plan. The model drafts scope, milestones and acceptance criteria; code then enforces the
// owner's budget and milestone limits, canonicalises the result and hashes it. That hash (termsHash)
// goes on chain with the job, so the criteria the agent later reviews against cannot be swapped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askJSON, modelName } from './llm.mjs';
import { canonicalHash } from './canonical.mjs';
import { toUnits } from '../lib/config.mjs';
import { PLANS_DIR } from './paths.mjs';

export const MAX_MILESTONES = 20;

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    reasoning: { type: 'string' },
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          deliverable: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          amountUSDC: { type: 'number' },
          deadlineDays: { type: 'integer' },
        },
        required: ['name', 'deliverable', 'acceptanceCriteria', 'amountUSDC', 'deadlineDays'],
      },
    },
    reviewPeriodHours: { type: 'integer' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'reasoning', 'milestones', 'reviewPeriodHours', 'risks'],
};

const SYSTEM = `You are Foreman, an AI contract manager for a small business. You turn a plain-English brief for a freelance job into a precise, fair plan: scope, milestones, acceptance criteria, amounts and deadlines. Respond in English.

How the plan will be used:
- Each milestone is escrowed in USDC and paid only when it is reviewed and approved. After the freelancer submits, an automated reviewer decides using ONLY evidence it can gather from public URLs: it can fetch a web page (HTTP status, title, headings, visible text, links), read a GitHub pull request / repository / commit (files changed, diff, checks, README), and run an LLM rubric over that evidence. It cannot log in, run code, or see private files.
- Therefore every acceptance criterion must be objective, specific and verifiable from a public deliverable URL (state which URL the freelancer must submit, e.g. "a GitHub PR link" or "the live site URL"). Avoid vague criteria such as "looks good" or "high quality".
- Write 2-5 criteria per milestone. Each is one self-contained sentence the reviewer can mark met or not met.
- Milestones must be small enough to review independently, ordered by dependency, and sum to no more than the budget. Amounts are in USDC. Deadlines are days from funding. reviewPeriodHours is how long the business has to review each submission (24-168, typically 48).
- Milestone names are short titles without numbering ("Landing page", not "1. Landing page").
- "reasoning" explains in a few sentences why you split the work this way and priced it so. "risks" lists real ambiguities or failure modes in the brief.`;

/** Draft a plan; if code-level checks fail, show the model the violation once and let it repair. */
export async function draftPlan({ brief, budgetUSDC, autoApproveCapUSDC = null, onAttempt }) {
  const capNote = autoApproveCapUSDC == null
    ? ''
    : `\nThe agent may approve on its own only milestones up to ${autoApproveCapUSDC} USDC; larger ones need the owner's co-signature. Do not distort the plan to avoid that, but prefer splitting work into milestones at or below this size where it is natural.`;
  const base = `BRIEF FROM THE OWNER:\n${brief}\n\nTOTAL BUDGET: at most ${budgetUSDC} USDC across all milestones (max ${MAX_MILESTONES} milestones).${capNote}`;

  let prompt = base;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    onAttempt?.(attempt);
    const raw = await askJSON({ system: SYSTEM, prompt, schema: PLAN_SCHEMA });
    try {
      return normalizePlan(raw, { budgetUSDC });
    } catch (e) {
      lastError = e;
      prompt = `${base}\n\nYOUR PREVIOUS DRAFT WAS REJECTED BY THE OWNER'S LIMITS: ${e.message}\nPrevious draft:\n${JSON.stringify(raw)}\n\nReturn a corrected plan.`;
    }
  }
  throw new Error(`could not produce a plan within limits: ${lastError.message}`);
}

/** Clean up model output and enforce the hard limits. Throws on a violation; returns the plan to be hashed. */
export function normalizePlan(raw, { budgetUSDC }) {
  const str = (s) => String(s ?? '').trim();
  const ms = (raw.milestones || []).map((m) => ({
    name: str(m.name),
    deliverable: str(m.deliverable),
    acceptanceCriteria: (m.acceptanceCriteria || []).map(str).filter(Boolean),
    amountUSDC: Math.round(Number(m.amountUSDC) * 1e6) / 1e6,
    deadlineDays: Math.max(1, Math.round(Number(m.deadlineDays) || 7)),
  }));
  if (ms.length === 0) throw new Error('plan has no milestones');
  if (ms.length > MAX_MILESTONES) throw new Error(`plan has ${ms.length} milestones, the limit is ${MAX_MILESTONES}`);
  ms.forEach((m, i) => {
    if (!(m.amountUSDC > 0)) throw new Error(`milestone ${i + 1} has no positive amount`);
    if (m.acceptanceCriteria.length === 0) throw new Error(`milestone ${i + 1} has no acceptance criteria`);
  });
  const total = ms.reduce((s, m) => s + toUnits(m.amountUSDC), 0n);
  if (total > toUnits(budgetUSDC)) throw new Error(`milestones total ${Number(total) / 1e6} USDC, over the ${budgetUSDC} USDC budget`);
  return {
    title: str(raw.title),
    summary: str(raw.summary),
    reasoning: str(raw.reasoning),
    milestones: ms,
    // Stagepay accepts 1 hour to 30 days.
    reviewPeriodHours: Math.min(720, Math.max(1, Math.round(Number(raw.reviewPeriodHours) || 48))),
    risks: (raw.risks || []).map(str).filter(Boolean),
  };
}

/** What the hash commits to: the owner's brief and the normalised plan. */
export const termsOf = ({ brief, plan }) => ({ version: 1, brief, plan });
export const termsHashOf = (file) => canonicalHash(termsOf(file));

/** Milestones the agent may not approve alone, given the policy's autoApproveCap (units). */
export const cosignRequired = (plan, capUnits) =>
  capUnits == null ? [] : plan.milestones.flatMap((m, i) => (toUnits(m.amountUSDC) > BigInt(capUnits) ? [i] : []));

export function savePlan({ brief, plan, budgetUSDC, capUnits = null }) {
  const termsHash = termsHashOf({ brief, plan });
  const file = {
    termsHash,
    brief,
    plan,
    budgetUSDC,
    checks: {
      totalUSDC: plan.milestones.reduce((s, m) => s + toUnits(m.amountUSDC), 0n).toString(),
      autoApproveCap: capUnits == null ? null : String(capUnits),
      cosignRequired: cosignRequired(plan, capUnits),
    },
    createdAt: new Date().toISOString(),
    model: modelName(),
  };
  mkdirSync(PLANS_DIR, { recursive: true });
  writeFileSync(join(PLANS_DIR, `${termsHash}.json`), JSON.stringify(file, null, 2));
  return file;
}

/** Load plans/<termsHash>.json and prove it still hashes to the on-chain value. Throws otherwise. */
export function loadPlan(termsHash) {
  const path = join(PLANS_DIR, `${String(termsHash).toLowerCase()}.json`);
  if (!existsSync(path)) throw new Error(`no plan file for termsHash ${termsHash} (expected ${path})`);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const actual = termsHashOf(file);
  if (actual.toLowerCase() !== String(termsHash).toLowerCase()) {
    throw new Error(`plan file does not match the on-chain termsHash (file hashes to ${actual}, job has ${termsHash})`);
  }
  return file;
}
