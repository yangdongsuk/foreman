// Foreman dashboard. Static page, no build step: reads ForemanPolicy, Stagepay and Tollgate straight
// from Arc and merges the chain events with the agent's published decision records.
import {
  createPublicClient, http, keccak256, toBytes, toHex, parseAbi, decodeEventLog, formatUnits,
} from 'https://esm.sh/viem@2.56.8';
import {
  CHAIN_ID, RPC, EXPLORER, POLICY, POLICY_DEPLOY_BLOCK, TOOLS_CHANNEL, STAGEPAY, TOLLGATE, TOKENS,
  DECISIONS_URL, REPO_URL,
} from './config.js';

// ---------------------------------------------------------------- canonical JSON
// The hash committed on chain is keccak256(utf8(canonicalJson(record))). The rule, shared byte for byte
// with agent/canonical.mjs, is:
//   - objects: keys sorted by UTF-16 code unit order, `undefined` members dropped
//   - arrays keep their order; `undefined` inside an array becomes null
//   - no whitespace anywhere
//   - bigint is written as a decimal string ("120000000")
//   - strings/numbers/booleans/null use JSON.stringify (non-finite numbers become null)
// Any change here must be mirrored in agent/canonical.mjs, otherwise every log shows a mismatch.
export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}
// Rebuilding objects with sorted keys and letting JSON.stringify do the rest keeps the output identical
// to agent/canonical.mjs in every edge case, including JS's own ordering of integer-like keys.
function normalize(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toJSON === 'function') return normalize(v.toJSON());
  if (Array.isArray(v)) return v.map(normalize);
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (v[k] !== undefined) out[k] = normalize(v[k]);
  }
  return out;
}
export const hashRecord = (record) => keccak256(toBytes(canonicalJson(record)));

// ---------------------------------------------------------------- ABIs (subset of lib/config.mjs)
const POLICY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function autoApproveCap() view returns (uint128)',
  'function dailyCap() view returns (uint128)',
  'function paused() view returns (bool)',
  'function escalated(uint256 jobId, uint256 index) view returns (bool)',
  'function spentToday() view returns (uint256)',
  'function remainingToday() view returns (uint256)',
  'event JobFunded(uint256 indexed jobId, address indexed freelancer, address token, uint256 total, bytes32 termsHash)',
  'event AgentDecision(uint256 indexed jobId, uint256 indexed index, uint8 action, uint256 amount, bytes32 reasonHash)',
  'event Escalated(uint256 indexed jobId, uint256 indexed index, uint256 amount, bytes32 reasonHash)',
  'event OwnerCosigned(uint256 indexed jobId, uint256 indexed index, uint256 amount)',
  'event LimitsSet(uint128 autoApproveCap, uint128 dailyCap)',
  'event AgentSet(address agent)',
  'event PausedSet(bool paused)',
]);
const STAGEPAY_ABI = parseAbi([
  'function jobs(uint256) view returns (address client, address freelancer, address token, uint64 reviewPeriod, bytes32 termsHash, uint256 total, uint256 settled)',
  'function getMilestones(uint256 jobId) view returns ((uint128 amount, uint64 deadline, uint64 submittedAt, uint8 status, uint8 revisions, address splitProposer, uint128 splitToFreelancer)[])',
]);
const TOLLGATE_ABI = parseAbi([
  'function channels(bytes32) view returns (address payer, address provider, address signer, address token, uint128 deposit, uint128 redeemed, uint64 grace, uint64 closeRequestedAt, bool closed)',
]);

const MILESTONE_STATUS = ['None', 'Funded', 'Submitted', 'Released', 'Refunded', 'Split']; // Stagepay.Status
const ACTIONS = ['approve', 'request_revision', 'escalate']; // AgentDecision.action
const VERDICT_LABEL = { approve: 'Approved', request_revision: 'Revision requested', escalate: 'Escalated' };
const MAX_REVISIONS = 3;
const LOG_STEP = 9000n; // blocks per eth_getLogs request
const MAX_LOG_REQUESTS = 600; // safety valve if POLICY_DEPLOY_BLOCK is unset

const pub = createPublicClient({ transport: http(RPC) });

// ---------------------------------------------------------------- tiny helpers
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const ext = 'target="_blank" rel="noopener"';
const addrLink = (a) => (a ? `<a class="mono" href="${EXPLORER}/address/${esc(a)}" ${ext} title="${esc(a)}">${short(a)}</a>` : '—');
const txLink = (h) => `<a class="mono" href="${EXPLORER}/tx/${esc(h)}" ${ext} title="${esc(h)}">${h.slice(0, 10)}…</a>`;
const decimalsOf = (token) => TOKENS[String(token).toLowerCase()]?.decimals ?? 6;
const symbolOf = (token) => TOKENS[String(token).toLowerCase()]?.symbol ?? 'USDC';
// Money: raw token units -> "120", "0.003". `sym` false returns the bare number.
const money = (units, sym = 'USDC', decimals = 6) => `${formatUnits(BigInt(units ?? 0), decimals)}${sym ? ` ${sym}` : ''}`;
const bi = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

function fmtTime(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(sec) {
  return new Date(Number(sec) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
// decidedAt may be an ISO string, epoch seconds or epoch milliseconds.
function toSeconds(t) {
  if (t == null) return 0;
  if (typeof t === 'number' || /^\d+$/.test(String(t))) { const n = Number(t); return n > 1e11 ? Math.floor(n / 1000) : n; }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}
// Escape first, then turn URLs into links (the href is already escaped).
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => {
    const clean = u.replace(/(&quot;|&#39;|[.,;:)])+$/, '');
    return `<a href="${clean}" ${ext}>${clean}</a>${u.slice(clean.length)}`;
  });
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------------------------------------------------------------- chain: logs
// Chunked getLogs with a retry that halves the range, since public RPCs cap the block span.
async function getLogsRange(address, from, to) {
  try {
    return await pub.request({ method: 'eth_getLogs', params: [{ address, fromBlock: toHex(from), toBlock: toHex(to) }] });
  } catch (e) {
    if (to - from < 500n) throw e;
    const mid = from + (to - from) / 2n;
    return [...await getLogsRange(address, from, mid), ...await getLogsRange(address, mid + 1n, to)];
  }
}

const logCache = { logs: [], scanned: BigInt(POLICY_DEPLOY_BLOCK) - 1n, truncated: false };

async function scanPolicyLogs() {
  const latest = await pub.getBlockNumber({ cacheTime: 0 });
  let from = logCache.scanned + 1n;
  const ranges = [];
  for (; from <= latest; from += LOG_STEP) ranges.push([from, from + LOG_STEP - 1n > latest ? latest : from + LOG_STEP - 1n]);
  if (ranges.length > MAX_LOG_REQUESTS) {
    ranges.splice(0, ranges.length - MAX_LOG_REQUESTS);
    logCache.truncated = true;
  }
  const chunks = await pool(ranges, 6, ([a, b]) => getLogsRange(POLICY, a, b));
  for (const raw of chunks.flat()) {
    try {
      const ev = decodeEventLog({ abi: POLICY_ABI, data: raw.data, topics: raw.topics });
      logCache.logs.push({
        name: ev.eventName, args: ev.args, tx: raw.transactionHash,
        block: BigInt(raw.blockNumber), idx: Number(BigInt(raw.logIndex)),
      });
    } catch { /* an event this dashboard does not know about */ }
  }
  logCache.scanned = latest;
  return logCache.logs;
}

const blockTimes = new Map();
async function blockTime(n) {
  const k = n.toString();
  if (!blockTimes.has(k)) {
    blockTimes.set(k, pub.getBlock({ blockNumber: n }).then((b) => Number(b.timestamp)).catch(() => 0));
  }
  return blockTimes.get(k);
}

// ---------------------------------------------------------------- data loading
async function loadDecisionFile() {
  try {
    const res = await fetch(DECISIONS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.decisions ?? [];
    const sample = !Array.isArray(body) && body.sample === true;
    return { entries: list.map((e) => ({ ...e, sample: e.sample === true || sample })), error: null };
  } catch (e) {
    const hint = location.protocol === 'file:'
      ? 'Browsers block reading data/decisions.json from file://. Serve the folder instead: python3 -m http.server -d web'
      : `Could not load ${DECISIONS_URL} (${e.message}).`;
    return { entries: [], error: hint };
  }
}

async function loadPolicy() {
  const read = (functionName) => pub.readContract({ address: POLICY, abi: POLICY_ABI, functionName });
  const [owner, agent, autoApproveCap, dailyCap, paused, spentToday, remainingToday] = await Promise.all(
    ['owner', 'agent', 'autoApproveCap', 'dailyCap', 'paused', 'spentToday', 'remainingToday'].map(read),
  );
  return { owner, agent, autoApproveCap, dailyCap, paused, spentToday, remainingToday };
}

async function loadJobs(logs) {
  const funded = logs.filter((l) => l.name === 'JobFunded').sort((a, b) => Number(b.args.jobId - a.args.jobId));
  return pool(funded, 4, async (l) => {
    const id = l.args.jobId;
    const [job, milestones] = await Promise.all([
      pub.readContract({ address: STAGEPAY, abi: STAGEPAY_ABI, functionName: 'jobs', args: [id] }),
      pub.readContract({ address: STAGEPAY, abi: STAGEPAY_ABI, functionName: 'getMilestones', args: [id] }),
    ]);
    const escalated = await Promise.all(milestones.map((m, i) => (m.status === 2
      ? pub.readContract({ address: POLICY, abi: POLICY_ABI, functionName: 'escalated', args: [id, BigInt(i)] }).catch(() => false)
      : false)));
    const [client, freelancer, token, reviewPeriod, termsHash, total, settled] = job;
    return { id, client, freelancer, token, reviewPeriod, termsHash, total, settled, milestones, escalated, tx: l.tx };
  });
}

async function loadChannel() {
  if (!TOOLS_CHANNEL) return null;
  const c = await pub.readContract({ address: TOLLGATE, abi: TOLLGATE_ABI, functionName: 'channels', args: [TOOLS_CHANNEL] });
  const [payer, provider, signer, token, deposit, redeemed, , closeRequestedAt, closed] = c;
  return { payer, provider, signer, token, deposit, redeemed, closeRequestedAt, closed };
}

// ---------------------------------------------------------------- timeline model
// Items are one of: decision (chain event and/or published record), cosign, pause, limits, agent.
async function buildTimeline(logs, entries) {
  const key = (job, idx, hash) => `${job}:${idx}:${String(hash).toLowerCase()}`;
  const byKey = new Map(entries.map((e) => [key(e.record.jobId, e.record.index, e.reasonHash), e]));
  const used = new Set();
  const items = [];

  for (const l of logs) {
    if (l.name === 'AgentDecision') {
      const k = key(l.args.jobId, l.args.index, l.args.reasonHash);
      const entry = byKey.get(k);
      if (entry) used.add(k);
      items.push({ kind: 'decision', chain: l, entry, ts: 0, order: Number(l.block) * 1e4 + l.idx });
    } else if (['OwnerCosigned', 'PausedSet', 'LimitsSet', 'AgentSet'].includes(l.name)) {
      items.push({ kind: l.name, chain: l, ts: 0, order: Number(l.block) * 1e4 + l.idx });
    }
  }
  for (const e of entries) {
    if (!used.has(key(e.record.jobId, e.record.index, e.reasonHash))) {
      items.push({ kind: 'decision', chain: null, entry: e, ts: toSeconds(e.record.decidedAt), order: 0 });
    }
  }
  await pool(items.filter((i) => i.chain), 8, async (i) => { i.ts = await blockTime(i.chain.block); });
  items.sort((a, b) => (b.ts - a.ts) || (b.order - a.order));
  return items;
}

// Verdict of the hash check for one decision item.
function verify(item) {
  if (!item.entry) return { state: 'none', computed: null, onchain: item.chain?.args.reasonHash };
  const computed = hashRecord(item.entry.record);
  const onchain = item.chain?.args.reasonHash;
  if (onchain) return { state: computed.toLowerCase() === onchain.toLowerCase() ? 'ok' : 'bad', computed, onchain };
  return { state: computed.toLowerCase() === String(item.entry.reasonHash).toLowerCase() ? 'self' : 'bad', computed, onchain: null };
}

// ---------------------------------------------------------------- rendering
function renderBanner(state) {
  const el = $('banner');
  const msgs = [];
  if (!POLICY) {
    msgs.push('<b>Foreman is not deployed yet.</b> No <code>POLICY</code> address is set in <code>config.js</code>, so the live cards below are placeholders. The decision timeline shows a <b>sample log</b> so you can see the audit trail and the hash check working.');
  }
  if (state.sample) msgs.push('<b>Sample data.</b> The decisions below are illustrative and have no on-chain counterpart. A real run overwrites <code>data/decisions.json</code>.');
  if (state.fileError) msgs.push(esc(state.fileError));
  if (logCache.truncated) msgs.push('Only the most recent blocks were scanned because <code>POLICY_DEPLOY_BLOCK</code> is not set; older history may be missing.');
  el.hidden = !msgs.length;
  el.innerHTML = msgs.map((m) => `<p>${m}</p>`).join('');
}

function stat(label, value, sub = '') {
  return `<div class="stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
}

function renderPolicy(p) {
  const el = $('policy');
  if (!p) {
    el.innerHTML = `<div class="policy-grid">
      <div class="kill idle"><span class="kill-label">Kill switch</span><b>Not deployed</b>
        <p>The owner can pause every agent action instantly with <code>setPaused(true)</code>; the owner's own functions keep working.</p></div>
      <div class="stats">
        ${stat('Auto-approve cap', '—', 'largest single release the agent can make alone')}
        ${stat('Daily cap', '—', 'most the agent can release in one UTC day')}
        ${stat('Spent today', '—')}
        ${stat('Remaining today', '—')}
      </div></div>
      <p class="note">Limits are enforced by the contract, not the prompt: the policy reverts with <code>OverAutoApproveCap</code>, <code>OverDailyCap</code> or <code>IsPaused</code>, whatever the model says. Anything above the cap is escalated for the owner to co-sign.</p>`;
    return;
  }
  const dailyCap = p.dailyCap;
  const pct = dailyCap > 0n ? Math.min(100, Number((p.spentToday * 10000n) / dailyCap) / 100) : 0;
  el.innerHTML = `<div class="policy-grid">
    <div class="kill ${p.paused ? 'paused' : 'active'}" id="kill-state" data-paused="${p.paused}">
      <span class="kill-label">Kill switch</span>
      <b>${p.paused ? 'PAUSED' : 'Agent active'}</b>
      <p>${p.paused
        ? 'All agent actions are blocked on chain. Only the owner can act or resume.'
        : 'The owner can pause every agent action instantly with <code>setPaused(true)</code>.'}</p>
    </div>
    <div class="stats">
      ${stat('Auto-approve cap', money(p.autoApproveCap), 'largest single release without the owner')}
      ${stat('Daily cap', money(p.dailyCap), 'most the agent can release per UTC day')}
      ${stat('Spent today', money(p.spentToday), `${pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}% of daily cap`)}
      ${stat('Remaining today', money(p.remainingToday))}
    </div></div>
    <div class="meter" role="img" aria-label="Daily cap used: ${pct}%"><i style="width:${pct}%"></i></div>
    <dl class="facts">
      <div><dt>Owner (business)</dt><dd>${addrLink(p.owner)}</dd></div>
      <div><dt>Agent (gas only)</dt><dd>${addrLink(p.agent)}</dd></div>
      <div><dt>Policy contract</dt><dd>${addrLink(POLICY)}</dd></div>
      <div><dt>Escrow</dt><dd>${addrLink(STAGEPAY)}</dd></div>
    </dl>
    <p class="note">Limits are enforced by the contract, not the prompt. Anything above the auto-approve cap is escalated and needs the owner's co-signature.</p>`;
}

const STATUS_CLASS = { Funded: 'funded', Submitted: 'submitted', Released: 'released', Refunded: 'refunded', Split: 'released', None: 'funded' };

function renderJobs(jobs, deployed) {
  const el = $('job-list');
  if (!deployed) {
    el.innerHTML = `<div class="empty"><b>No jobs yet.</b><p>Once ForemanPolicy is deployed, every job the owner funds through it shows up here with its milestones and status. The agent never holds job money: Stagepay escrow does.</p></div>`;
    return;
  }
  if (!jobs.length) {
    el.innerHTML = `<div class="empty"><b>No jobs funded yet.</b><p>Create one with <code>node agent/foreman.mjs plan</code> then <code>fund</code>.</p></div>`;
    return;
  }
  el.innerHTML = jobs.map((j) => {
    const sym = symbolOf(j.token);
    const dec = decimalsOf(j.token);
    const rows = j.milestones.map((m, i) => {
      const status = MILESTONE_STATUS[m.status] ?? 'None';
      const pending = j.escalated[i] ? '<span class="chip warn">Awaiting owner co-sign</span>' : '';
      const revs = m.revisions ? `<span class="muted">${m.revisions}/${MAX_REVISIONS} revisions</span>` : '';
      return `<div class="ms">
        <span class="ms-n">${i + 1}</span>
        <span class="ms-amt">${money(m.amount, sym, dec)}</span>
        <span class="chip ${STATUS_CLASS[status]}">${status}</span>
        ${pending}${revs}
        <span class="muted ms-due">due ${fmtDay(m.deadline)}</span>
      </div>`;
    }).join('');
    const done = j.milestones.filter((m) => [3, 4, 5].includes(m.status)).length;
    return `<article class="card job">
      <header><h3>Job #${j.id}</h3><span class="muted">${done}/${j.milestones.length} milestones settled</span></header>
      <dl class="facts">
        <div><dt>Freelancer</dt><dd>${addrLink(j.freelancer)}</dd></div>
        <div><dt>Escrowed</dt><dd>${money(j.total, sym, dec)}</dd></div>
        <div><dt>Settled</dt><dd>${money(j.settled, sym, dec)}</dd></div>
        <div><dt>Plan hash</dt><dd class="mono" title="${esc(j.termsHash)}">${esc(j.termsHash.slice(0, 14))}…</dd></div>
        <div><dt>Funding tx</dt><dd>${txLink(j.tx)}</dd></div>
      </dl>
      <div class="ms-list">${rows}</div>
    </article>`;
  }).join('');
}

function stepCost(step) { return step.receipt ? bi(step.receipt.price) : 0n; }

function renderDecision(item, jobsById, cosigns) {
  const { entry, chain } = item;
  const r = entry?.record;
  const v = verify(item);
  const verdict = r?.verdict ?? ACTIONS[chain.args.action];
  const jobId = r ? r.jobId : chain.args.jobId;
  const index = r ? r.index : chain.args.index;
  const amount = r ? bi(r.amountUnits) : chain.args.amount;
  const when = item.ts ? fmtTime(item.ts) : '';
  const sample = entry?.sample;
  const hashBadge = {
    ok: '<span class="check ok">✓ log matches on-chain hash</span>',
    bad: '<span class="check bad">✗ mismatch: record does not match its hash</span>',
    self: `<span class="check self">✓ record matches its hash · ${sample ? 'sample, no on-chain counterpart' : 'not on chain yet'}</span>`,
    none: '<span class="check none">No published record for this on-chain hash</span>',
  }[v.state];

  let body = '';
  if (r) {
    const criteria = (r.criteria ?? []).map((c) => `<tr><td class="met ${c.met ? 'yes' : 'no'}" aria-label="${c.met ? 'met' : 'not met'}">${c.met ? '✓' : '✗'}</td><td>${esc(c.criterion)}</td><td class="muted">${esc(c.evidence)}</td></tr>`).join('');
    const steps = (r.steps ?? []).map((s, n) => `<li>
        <span class="step-n">${n + 1}</span>
        <div><b>${s.tool ? esc(s.tool) : 'decide'}</b>${s.tool ? ` <span class="chip cost">${money(stepCost(s), 'USDC')}</span>` : ''}
        <p class="muted">${esc(s.thought)}</p>
        ${s.resultDigest ? `<p class="digest">${esc(s.resultDigest)}</p>` : ''}</div></li>`).join('');
    const guard = (r.guardrails ?? []).length
      ? `<div class="guard"><b>Guardrails fired</b><ul>${r.guardrails.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : '';
    body = `
      <p class="rationale">${esc(r.rationale)}</p>
      ${guard}
      ${criteria ? `<table class="criteria"><thead><tr><th></th><th>Acceptance criterion</th><th>Evidence</th></tr></thead><tbody>${criteria}</tbody></table>` : ''}
      <details><summary>Tools used · ${money(r.toolSpendUnits ?? 0, 'USDC')}</summary><ol class="steps">${steps}</ol></details>
      ${r.feedbackToFreelancer ? `<details><summary>Feedback sent to the freelancer</summary><p>${esc(r.feedbackToFreelancer)}</p></details>` : ''}
      ${r.submissionNote ? `<details><summary>Submission reviewed</summary><p>${linkify(r.submissionNote)}</p></details>` : ''}`;
  } else {
    body = '<p class="rationale muted">The agent committed this hash on chain but no matching record is published, so the reasoning cannot be shown or verified.</p>';
  }

  const cosign = verdict === 'escalate' ? cosigns.get(`${jobId}:${index}`) : null;
  const job = jobsById.get(String(jobId));
  const stillEscalated = verdict === 'escalate' && job?.escalated[Number(index)] && !cosign;
  let tail = '';
  if (verdict === 'escalate') {
    tail = cosign
      ? `<span class="chip released">Owner co-signed · ${txLink(cosign.tx)}</span>`
      : (stillEscalated || sample || !chain) ? '<span class="chip warn">Awaiting owner co-sign</span>' : '';
  }
  const txPart = chain ? `<span>${txLink(chain.tx)}</span>` : `<span class="muted">${sample ? 'sample · no transaction' : 'tx pending'}</span>`;

  return `<article class="decision card" data-verdict="${esc(verdict)}" data-check="${v.state}">
    <header>
      <span class="chip verdict ${esc(verdict)}">${esc(VERDICT_LABEL[verdict] ?? verdict)}</span>
      <h3>Job #${esc(jobId)} · milestone ${Number(index) + 1} <span class="amt">${money(amount)}</span></h3>
      ${sample ? '<span class="chip sample">Sample</span>' : ''}
      <time class="muted">${esc(when)}</time>
    </header>
    ${body}
    <footer>
      ${hashBadge}
      ${tail}
      ${txPart}
    </footer>
    ${v.computed || v.onchain ? `<details class="hashes"><summary>Show hashes</summary>
      <dl>
        ${v.computed ? `<dt>keccak256(canonical JSON of record)</dt><dd class="mono">${esc(v.computed)}</dd>` : ''}
        ${v.onchain ? `<dt>reasonHash on chain</dt><dd class="mono">${esc(v.onchain)}</dd>` : ''}
        ${!v.onchain && entry?.reasonHash ? `<dt>reasonHash in log file</dt><dd class="mono">${esc(entry.reasonHash)}</dd>` : ''}
      </dl>
      <p class="muted">Rule: sorted keys, no whitespace, bigint as string, UTF-8, keccak256. Same function as <code>agent/canonical.mjs</code>.</p>
    </details>` : ''}
  </article>`;
}

function renderAdmin(item) {
  const { kind, chain } = item;
  const a = chain.args;
  const text = {
    PausedSet: a.paused ? '<b>Owner engaged the kill switch.</b> All agent actions are blocked.' : '<b>Owner resumed the agent.</b>',
    LimitsSet: `<b>Owner changed the limits:</b> auto-approve cap ${money(a.autoApproveCap)}, daily cap ${money(a.dailyCap)}.`,
    AgentSet: `<b>Owner set the agent address</b> to ${addrLink(a.agent)}.`,
    OwnerCosigned: `<b>Owner co-signed</b> job #${a.jobId} milestone ${Number(a.index) + 1} (${money(a.amount)}).`,
  }[kind];
  const cls = kind === 'PausedSet' && a.paused ? 'danger' : '';
  return `<div class="admin ${cls}"><span>${text}</span><span class="muted">${fmtTime(item.ts)} · ${txLink(chain.tx)}</span></div>`;
}

function renderTimeline(items, jobs) {
  const el = $('timeline');
  if (!items.length) {
    el.innerHTML = `<div class="empty"><b>No decisions yet.</b><p>When the agent reviews a submitted milestone, its decision, reasoning, evidence and tool costs appear here, with the hash check against the chain.</p></div>`;
    return;
  }
  const jobsById = new Map(jobs.map((j) => [String(j.id), j]));
  const cosigns = new Map(items.filter((i) => i.kind === 'OwnerCosigned').map((i) => [`${i.chain.args.jobId}:${i.chain.args.index}`, i.chain]));
  const decisions = items.filter((i) => i.kind === 'decision');
  const checks = decisions.map(verify);
  const count = (s) => checks.filter((c) => c.state === s).length;
  const verdictCount = (v) => decisions.filter((d) => (d.entry?.record.verdict ?? ACTIONS[d.chain.args.action]) === v).length;
  const summary = `<div class="summary">
      <span><b>${decisions.length}</b> decisions</span>
      <span><b>${verdictCount('approve')}</b> approved</span>
      <span><b>${verdictCount('request_revision')}</b> sent back</span>
      <span><b>${verdictCount('escalate')}</b> escalated</span>
      <span class="${count('bad') ? 'bad' : 'good'}"><b>${count('ok') + count('self')}</b> hashes verified · <b>${count('bad')}</b> mismatches</span>
    </div>`;
  el.innerHTML = summary + items.map((i) => (i.kind === 'decision' ? renderDecision(i, jobsById, cosigns) : renderAdmin(i))).join('');
}

function renderSpend(channel, entries) {
  const el = $('spend-card');
  // Per-tool totals come from the receipts inside the decision records.
  const tools = new Map();
  let logTotal = 0n;
  let released = 0n;
  for (const e of entries) {
    if (e.record.verdict === 'approve') released += bi(e.record.amountUnits);
    for (const s of e.record.steps ?? []) {
      if (!s.tool || !s.receipt) continue;
      const t = tools.get(s.tool) ?? { calls: 0, units: 0n };
      t.calls += 1; t.units += bi(s.receipt.price); logTotal += bi(s.receipt.price);
      tools.set(s.tool, t);
    }
  }
  let chainPart = '';
  if (channel) {
    const dec = decimalsOf(channel.token);
    const avail = channel.closed ? 0n : channel.deposit - channel.redeemed;
    const pct = channel.deposit > 0n ? Number((channel.redeemed * 10000n) / channel.deposit) / 100 : 0;
    chainPart = `<div class="stats">
        ${stat('Channel deposit', money(channel.deposit, symbolOf(channel.token), dec), 'the most the agent can ever spend')}
        ${stat('Redeemed by tool server', money(channel.redeemed, symbolOf(channel.token), dec), `${pct.toFixed(1)}% of deposit`)}
        ${stat('Still available', money(avail, symbolOf(channel.token), dec), channel.closed ? 'channel closed' : 'for vouchers')}
      </div>
      <div class="meter" role="img" aria-label="Channel used ${pct}%"><i style="width:${Math.min(100, pct)}%"></i></div>
      <p class="note">The session key that signs vouchers holds no funds. Its worst-case loss is this channel's balance, and the provider redeems in batches, so the redeemed figure trails the log below. Channel ${txLinkChannel(TOOLS_CHANNEL)}.</p>`;
  } else {
    chainPart = '<p class="note">No <code>TOOLS_CHANNEL</code> is set in <code>config.js</code>, so the on-chain channel balance is not shown. The breakdown below comes from the agent\'s decision log.</p>';
  }
  let logPart = '';
  if (tools.size) {
    const rows = [...tools.entries()].sort((a, b) => Number(b[1].units - a[1].units)).map(([name, t]) =>
      `<tr><td>${esc(name)}</td><td>${t.calls}</td><td>${money(t.units, '')}</td><td>${money(t.units / BigInt(t.calls), '')}</td></tr>`).join('');
    const per100 = released > 0n ? money((logTotal * 100_000_000n) / released, 'USDC') : null;
    logPart = `<table class="spend"><thead><tr><th>Tool</th><th>Calls</th><th>USDC spent</th><th>Per call</th></tr></thead><tbody>${rows}
      <tr class="total"><td>Total</td><td>${[...tools.values()].reduce((n, t) => n + t.calls, 0)}</td><td>${money(logTotal, '')}</td><td></td></tr></tbody></table>
      ${per100 ? `<p class="note"><b>${per100}</b> of tool spend per 100 USDC of milestones approved: reviewing costs a rounding error next to the money it protects.</p>` : ''}`;
  } else {
    logPart = '<p class="muted">No paid tool calls recorded yet.</p>';
  }
  el.innerHTML = chainPart + logPart;
}
const txLinkChannel = (id) => `<a class="mono" href="${EXPLORER}/address/${TOLLGATE}" ${ext} title="${esc(id)}">${esc(id.slice(0, 10))}…</a>`;

// ---------------------------------------------------------------- boot
function showError(id, label, e) {
  $(id).innerHTML = `<div class="empty err"><b>Could not read ${esc(label)}.</b><p>${esc(e.shortMessage || e.message || e)}</p></div>`;
}

async function load() {
  const file = await loadDecisionFile();
  const entries = file.entries.filter((e) => e?.record && e.reasonHash);
  const state = { sample: entries.some((e) => e.sample), fileError: file.error };
  const net = $('net');

  if (!POLICY) {
    net.textContent = 'Not deployed';
    net.className = 'pill warn';
    renderPolicy(null);
    renderJobs([], false);
    renderSpend(null, entries);
    renderTimeline(await buildTimeline([], entries), []);
    renderBanner(state);
    return;
  }

  net.textContent = CHAIN_ID === 5042 ? 'Arc mainnet' : `Chain ${CHAIN_ID}`;
  net.className = 'pill ok';
  let logs = [];
  let jobs = [];
  try { logs = await scanPolicyLogs(); } catch (e) { showError('job-list', 'policy events', e); }
  await Promise.allSettled([
    loadPolicy().then(renderPolicy, (e) => showError('policy', 'the policy contract', e)),
    loadJobs(logs).then((j) => { jobs = j; renderJobs(j, true); }, (e) => showError('job-list', 'jobs', e)),
    loadChannel().then((c) => renderSpend(c, entries), (e) => { showError('spend-card', 'the Tollgate channel', e); }),
  ]);
  try { renderTimeline(await buildTimeline(logs, entries), jobs); } catch (e) { showError('timeline', 'decisions', e); }
  renderBanner(state);
}

$('foot-links').innerHTML = `<a href="${REPO_URL}" ${ext}>Source</a> · <a href="${EXPLORER}/address/${STAGEPAY}" ${ext}>Stagepay</a> · <a href="${EXPLORER}/address/${TOLLGATE}" ${ext}>Tollgate</a>${POLICY ? ` · <a href="${EXPLORER}/address/${POLICY}" ${ext}>ForemanPolicy</a>` : ''}`;

load().catch((e) => { renderBanner({ fileError: `Unexpected error: ${e.message}` }); console.error(e); });
// New decisions and kill-switch flips show up without a reload; log scans are incremental.
if (POLICY) setInterval(() => load().catch(console.error), 30_000);
