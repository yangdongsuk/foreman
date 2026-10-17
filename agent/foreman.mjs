#!/usr/bin/env node
// Foreman CLI. Usage: node agent/foreman.mjs <command> [options]   (see `help`)
import { createInterface } from 'node:readline/promises';
import { ADDR, fmtUSDC, toUnits } from '../lib/config.mjs';
import * as chain from './chain.mjs';
import { draftPlan, savePlan, loadPlan, cosignRequired } from './plan.mjs';
import { reviewMilestone, readDecisions, hasDecision } from './review.mjs';
import { ToolClient } from './tools-client.mjs';
import { modelName } from './llm.mjs';
import { canonicalHash } from './canonical.mjs';
import * as ui from './ui.mjs';
import { c } from './ui.mjs';

const HELP = `
${c.bold('foreman')} - an AI agent that runs freelance contracts inside limits a smart contract enforces

  plan    --brief "<text>" --budget <usdc> [--yes]     draft, check and hash a plan
  fund    --plan <termsHash> --freelancer <addr> [--token USDC|EURC]    escrow it (OWNER key)
  review  --job <id> [--index <i>] [--force]            review submitted milestones (AGENT key)
  watch   --job <id> [--interval 15]                    keep reviewing until every milestone settles
  cosign  --job <id> --index <i>                        approve an escalated milestone (OWNER key)
  pause | resume                                        owner kill switch (OWNER key)
  limits                                                print the on-chain policy
  submit  --job <id> --index <i> --note "<text>"        demo helper: freelancer submits (FREELANCER key)
  status  --job <id>                                    milestones, decisions, tool spend
`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[k] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { cmd: rest[0], flags };
}

const need = (flags, k) => {
  if (flags[k] === undefined || flags[k] === true) throw new Error(`missing --${k} (try: foreman help)`);
  return flags[k];
};
const int = (v, name) => {
  if (!/^\d+$/.test(String(v))) throw new Error(`--${name} must be a non-negative integer`);
  return Number(v);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- plan

async function capUnits() {
  if (ADDR.POLICY) {
    try {
      return (await Promise.race([chain.readPolicy(), sleep(6000).then(() => { throw new Error('timeout'); })])).autoApproveCap;
    } catch { /* fall through to env */ }
  }
  return process.env.AUTO_APPROVE_CAP ? BigInt(process.env.AUTO_APPROVE_CAP) : null;
}

async function cmdPlan({ brief, budget, yes }) {
  if (!brief || brief === true) throw new Error('missing --brief "<text>"');
  const budgetUSDC = Number(need({ budget }, 'budget'));
  if (!(budgetUSDC > 0)) throw new Error('--budget must be a positive USDC amount');

  ui.header('plan', `model ${modelName()}`);
  ui.kv('brief', '');
  console.log(ui.wrap(brief, 4));
  ui.kv('budget', `up to ${budgetUSDC} USDC`);
  const cap = await capUnits();
  ui.kv('agent limit', cap == null ? c.gray('auto-approve cap unknown (no policy configured)') : `auto-approves up to ${ui.usdc(cap)} per milestone`);

  ui.blank();
  let stop = ui.spinner('drafting scope, milestones and acceptance criteria');
  let plan;
  try {
    plan = await draftPlan({
      brief, budgetUSDC, autoApproveCapUSDC: cap == null ? null : fmtUSDC(cap),
      onAttempt: (n) => { if (n > 1) { stop(); ui.warn('draft broke a limit, asking the model to repair it'); stop = ui.spinner('revising the plan'); } },
    });
  } finally { stop(); }

  const cosign = cosignRequired(plan, cap);
  printPlan(plan, cosign, budgetUSDC);

  if (yes !== true) {
    if (!process.stdin.isTTY) { ui.warn('not saved: re-run with --yes to sign off non-interactively'); return; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\n  ${c.bold('Sign off on this plan?')} [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') { ui.warn('not saved'); return; }
  }
  const file = savePlan({ brief, plan, budgetUSDC, capUnits: cap });
  ui.blank();
  ui.ok(`signed off. terms hash ${c.bold(file.termsHash)}`);
  ui.kv('saved', `plans/${file.termsHash}.json`);
  ui.kv('next', c.cyan(`foreman fund --plan ${file.termsHash} --freelancer <address>`));
}

function printPlan(plan, cosign, budgetUSDC) {
  ui.section(c.bold(plan.title));
  console.log(ui.wrap(plan.summary, 2));
  ui.blank();
  ui.table(
    [{ title: '#' }, { title: 'milestone' }, { title: 'USDC', right: true }, { title: 'due', right: true }, { title: 'approval' }],
    plan.milestones.map((m, i) => [
      String(i + 1), c.bold(ui.clipLine(m.name, 38)), String(m.amountUSDC), `${m.deadlineDays}d`,
      cosign.includes(i) ? c.yellow('owner co-sign') : c.green('agent auto'),
    ]),
  );
  const total = plan.milestones.reduce((s, m) => s + toUnits(m.amountUSDC), 0n);
  ui.kv('total', `${c.bold(ui.usdc(total))} of ${budgetUSDC} USDC budget   review period ${plan.reviewPeriodHours} h`);
  plan.milestones.forEach((m, i) => {
    ui.section(`Milestone ${i + 1}: ${m.name}`);
    console.log(c.gray(ui.wrap(`Deliverable: ${m.deliverable}`, 2)));
    m.acceptanceCriteria.forEach((cr) => console.log(ui.wrap(`- ${cr}`, 4)));
  });
  ui.section('Why this plan');
  console.log(ui.wrap(plan.reasoning, 2));
  if (plan.risks.length) {
    ui.section('Risks');
    plan.risks.forEach((r) => console.log(ui.wrap(`- ${r}`, 2)));
  }
}

// ------------------------------------------------------------------- fund

async function cmdFund({ plan: hash, freelancer, token = 'USDC' }) {
  const file = loadPlan(need({ plan: hash }, 'plan')); // refuses a file that does not hash to its name
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(need({ freelancer }, 'freelancer')))) throw new Error('--freelancer must be an address');
  const tokenAddr = ADDR[String(token).toUpperCase()];
  if (!tokenAddr || String(token).toUpperCase() === 'POLICY') throw new Error('--token must be USDC or EURC');

  const now = await chain.chainNow();
  const amounts = file.plan.milestones.map((m) => toUnits(m.amountUSDC));
  const total = amounts.reduce((a, b) => a + b, 0n);
  ui.header('fund', file.plan.title);
  const balance = await chain.tokenBalance(tokenAddr, chain.addressOf('OWNER'));
  ui.kv('terms hash', `${ui.short(file.termsHash)} ${c.green('✓ verified')}`);
  ui.kv('freelancer', freelancer);
  ui.kv('escrow', `${c.bold(ui.usdc(total))} in ${amounts.length} milestones, held by Stagepay, not by the agent`);
  ui.kv('owner balance', ui.usdc(balance));
  if (balance < total) throw new Error(`owner holds ${ui.usdc(balance)} but the plan needs ${ui.usdc(total)}`);

  const stop = ui.spinner('approving the policy and funding the job');
  let res;
  try {
    res = await chain.fundJob({
      freelancer, token: tokenAddr, amounts, termsHash: file.termsHash,
      deadlines: file.plan.milestones.map((m) => BigInt(now + m.deadlineDays * 86400)),
      reviewPeriod: file.plan.reviewPeriodHours * 3600,
    });
  } finally { stop(); }
  ui.blank();
  ui.ok(`job funded: ${c.bold(`job #${res.jobId}`)}`);
  ui.kv('tx', ui.link(res.url));
  ui.kv('next', c.cyan(`foreman submit --job ${res.jobId} --index 0 --note "<deliverable URL>"`));
}

// ------------------------------------------------------------ review/watch

async function reviewOne(jobId, index) {
  const result = await reviewMilestone({ jobId, index, emit: ui.reviewRenderer() });
  ui.blank();
  return result;
}

async function pending(jobId, force, only) {
  const ms = await chain.readMilestones(jobId);
  return ms.filter((m) =>
    m.statusName === 'Submitted' && (only === undefined || m.index === only) && (force || !hasDecision(jobId, m.index, m.submittedAt)));
}

async function cmdReview({ job, index, force }) {
  const jobId = int(need({ job }, 'job'), 'job');
  const only = index === undefined ? undefined : int(index, 'index');
  const todo = await pending(jobId, force === true, only);
  if (!todo.length) {
    ui.header('review', `job #${jobId}`);
    ui.ok('nothing to review: no submitted milestone without a decision');
    return;
  }
  for (const m of todo) await reviewOne(jobId, m.index);
}

async function cmdWatch({ job, interval = '15' }) {
  const jobId = int(need({ job }, 'job'), 'job');
  const every = Math.max(2, int(interval, 'interval')) * 1000;
  ui.header('watch', `job #${jobId}, polling every ${every / 1000}s`);
  const idle = (text) => process.stdout.isTTY ? process.stdout.write(`\r  ${c.gray(`… ${text}`)}\x1b[K`) : null;
  for (;;) {
    const ms = await chain.readMilestones(jobId);
    if (ms.every((m) => ['Released', 'Refunded', 'Split'].includes(m.statusName))) {
      process.stdout.write('\r\x1b[K');
      ui.ok('every milestone is settled');
      return cmdStatus({ job: String(jobId) });
    }
    const policy = await chain.readPolicy();
    const todo = await pending(jobId, false);
    if (policy.paused) idle('paused by the owner: agent idle');
    else if (todo.length) {
      process.stdout.write('\r\x1b[K');
      for (const m of todo) {
        try { await reviewOne(jobId, m.index); } catch (e) { ui.fail(`milestone ${m.index + 1}: ${e.message}`); }
      }
    } else idle(`waiting for submissions (${ms.filter((m) => m.statusName === 'Released').length}/${ms.length} paid)  ${new Date().toLocaleTimeString()}`);
    await sleep(every);
  }
}

// ----------------------------------------------------- owner/freelancer acts

async function cmdCosign({ job, index }) {
  const jobId = int(need({ job }, 'job'), 'job');
  const i = int(need({ index }, 'index'), 'index');
  ui.header('cosign', `job #${jobId} · milestone ${i + 1}`);
  const m = (await chain.readMilestones(jobId))[i];
  ui.kv('amount', ui.usdc(m.amount));
  const res = await chain.ownerCosign(jobId, i);
  ui.ok(`owner co-signed: ${ui.usdc(m.amount)} released to the freelancer`);
  ui.kv('tx', ui.link(res.url));
}

async function cmdPause(paused) {
  ui.header(paused ? 'pause' : 'resume');
  const res = await chain.setPaused(paused);
  if (paused) ui.out(`  ${c.bgRed(' PAUSED ')} the contract now rejects every agent action`);
  else ui.out(`  ${c.bgGreen(' RESUMED ')} the agent may act again, inside its limits`);
  ui.kv('tx', ui.link(res.url));
}

async function cmdSubmit({ job, index, note }) {
  const jobId = int(need({ job }, 'job'), 'job');
  const i = int(need({ index }, 'index'), 'index');
  ui.header('submit', `job #${jobId} · milestone ${i + 1} (demo freelancer)`);
  ui.kv('note', need({ note }, 'note'));
  const res = await chain.freelancerSubmit(jobId, i, String(note));
  ui.ok('milestone submitted, review window started');
  ui.kv('tx', ui.link(res.url));
}

// ------------------------------------------------------------ limits/status

async function cmdLimits() {
  const p = await chain.readPolicy();
  ui.header('limits', 'enforced by ForemanPolicy, not by the prompt');
  ui.kv('contract', p.address);
  ui.kv('owner', p.owner);
  ui.kv('agent', p.agent);
  ui.kv('auto-approve', `${c.bold(ui.usdc(p.autoApproveCap))} per milestone`);
  ui.kv('daily cap', `${c.bold(ui.usdc(p.dailyCap))}   spent today ${ui.usdc(p.spentToday)}   left ${ui.usdc(p.remainingToday)}`);
  ui.kv('state', p.paused ? c.bgRed(' PAUSED ') : c.bgGreen(' ACTIVE '));
  const tools = new ToolClient();
  if (tools.ready) {
    try {
      const b = await tools.budget();
      ui.kv('tool channel', `deposit ${ui.usdc(b.deposit)}   redeemed ${ui.usdc(b.redeemed)}   signed ${ui.usdc(b.signed)}   available ${ui.usdc(b.remaining)}`);
    } catch (e) { ui.kv('tool channel', c.gray(`unreadable (${e.message.slice(0, 60)})`)); }
  }
}

async function cmdStatus({ job }) {
  const jobId = int(need({ job }, 'job'), 'job');
  const j = await chain.readJob(jobId);
  const ms = await chain.readMilestones(jobId);
  let plan = null;
  try { plan = loadPlan(j.termsHash); } catch { /* status still works without the plan file */ }
  const decisions = readDecisions().filter((d) => d.record.jobId === jobId);
  ui.header(`status  job #${jobId}`, plan?.plan.title ?? '');
  ui.kv('escrow', `${ui.usdc(j.total)} total, ${ui.usdc(j.settled)} settled`);
  ui.kv('freelancer', j.freelancer);
  ui.kv('terms hash', `${ui.short(j.termsHash)} ${plan ? c.green('✓ plan file verified') : c.yellow('plan file missing')}`);
  ui.blank();
  const rows = await Promise.all(ms.map(async (m) => {
    const d = decisions.filter((x) => x.record.index === m.index).at(-1);
    const escalated = m.statusName === 'Submitted' && (await chain.isEscalated(jobId, m.index));
    return [
      String(m.index + 1), c.bold(ui.clipLine(plan?.plan.milestones[m.index]?.name ?? '-', 30)), ui.usdc(m.amount),
      escalated ? c.red('Escalated') : ui.statusColor(m.statusName), `${m.revisions}`,
      d ? `${d.record.verdict} ${c.gray(ui.short(d.reasonHash, 6))}` : c.gray('-'), d ? ui.usdc(d.record.toolSpendUnits) : c.gray('-'),
    ];
  }));
  ui.table(
    [{ title: '#' }, { title: 'milestone' }, { title: 'amount', right: true }, { title: 'status' }, { title: 'rev' }, { title: 'last decision' }, { title: 'tools', right: true }],
    rows,
  );
  const spend = decisions.reduce((s, d) => s + BigInt(d.record.toolSpendUnits), 0n);
  ui.blank();
  ui.kv('decisions', `${decisions.length} recorded, tool spend ${ui.usdc(spend)}`);
  for (const d of decisions.slice(-3)) {
    const ok = canonicalHash(d.record) === d.reasonHash;
    ui.kv(`m${d.record.index + 1} ${d.record.verdict}`, `${ok ? c.green('✓ record matches reasonHash') : c.red('✗ record was altered')}  ${ui.link(d.explorer)}`, 22);
  }
}

// ------------------------------------------------------------------- main

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'plan': return cmdPlan(flags);
    case 'fund': return cmdFund(flags);
    case 'review': return cmdReview(flags);
    case 'watch': return cmdWatch(flags);
    case 'cosign': return cmdCosign(flags);
    case 'pause': return cmdPause(true);
    case 'resume': return cmdPause(false);
    case 'limits': return cmdLimits();
    case 'submit': return cmdSubmit(flags);
    case 'status': return cmdStatus(flags);
    case undefined: case 'help': case '--help': console.log(HELP); return;
    default: throw new Error(`unknown command "${cmd}" (try: foreman help)`);
  }
}

main().catch((e) => {
  console.error(`\n  ${c.red('✗')} ${e instanceof chain.ChainError || e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
