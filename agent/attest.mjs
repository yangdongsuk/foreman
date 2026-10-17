// `foreman attest`: run the Chainlink CRE review workflow for one milestone and let the CRE
// forwarder write the signed result to ForemanReviewReceiver on Arc Testnet.
//
// This is the simulation path: `cre workflow simulate --broadcast` runs the workflow locally, then
// really sends the report through Chainlink's MockKeystoneForwarder. Deploying to a DON needs
// CRE deploy access, which this account does not have yet. The escrow flow (Stagepay + ForemanPolicy)
// is not touched by this module.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, parseAbi, decodeEventLog } from 'viem';
import * as chain from './chain.mjs';
import { loadPlan } from './plan.mjs';
import { LOG_DIR, ROOT, STATE_DIR } from './paths.mjs';
import * as ui from './ui.mjs';
import { c } from './ui.mjs';

export const CRE_DIR = join(ROOT, 'cre');
export const WORKFLOW = 'foreman-review';
export const WORKFLOW_CONFIG = join(CRE_DIR, WORKFLOW, 'config.staging.json');
export const ATTESTATIONS_FILE = join(LOG_DIR, 'cre-attestations.jsonl');

const TESTNET = { id: 5042002, name: 'Arc Testnet', rpc: process.env.CRE_RPC_URL || 'https://rpc.testnet.arc.io', explorer: 'https://testnet.arcscan.app' };
export const VERDICTS = ['approve', 'request_revision', 'escalate'];

const RECEIVER_ABI = parseAbi([
  'event ReviewAttested(uint256 indexed jobId, uint256 indexed index, uint8 verdict, bytes32 reasonHash, bytes32 evidenceHash, uint256 timestamp)',
]);

// ----------------------------------------------------------- payload (pure)

/** The first http(s) URL in the freelancer's submission note: that is the deliverable the workflow inspects. */
export function extractUrl(note) {
  const m = String(note ?? '').match(/https?:\/\/[^\s"'<>)\]]+/);
  return m ? m[0].replace(/[.,;:]+$/, '') : null;
}

/** HTTP trigger body for the workflow, from the plan file and the on-chain milestone. */
export function buildPayload({ jobId, index, plan, milestone, note }) {
  const planned = plan.plan.milestones[index];
  if (!planned) throw new Error(`the plan has no milestone ${index + 1}`);
  const deliverableUrl = extractUrl(note);
  if (!deliverableUrl) throw new Error(`the submission note for milestone ${index + 1} has no URL (note: ${JSON.stringify(note)})`);
  return {
    jobId,
    index,
    deliverableUrl,
    criteria: planned.acceptanceCriteria,
    amountUnits: Number(milestone.amount),
    revisionsUsed: Number(milestone.revisions),
  };
}

// ------------------------------------------------------ simulator output

// The CLI paints spinners with cursor-control sequences; keep only readable text.
const ANSI_ALL = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const clean = (s) => s.replace(ANSI_ALL, '').replace(/\r\n/g, '\n').replace(/[^\n]*\r/g, '').replace(/\^D\x08*/g, '');

/** "2026-10-18T02:01:48Z [USER LOG] message" -> "message" (null for every other line). */
export function userLog(line) {
  const m = line.match(/\[USER LOG\]\s+(.*)$/);
  return m ? m[1] : null;
}

/** The workflow returns canonical JSON; the CLI prints it as an escaped JSON string after "Simulation Result:". */
export function parseResult(output) {
  const m = output.match(/Workflow Simulation Result:\s*\n?\s*("(?:[^"\\]|\\.)*")/);
  if (!m) return null;
  try { return JSON.parse(JSON.parse(m[1])); } catch { return null; }
}

/** Print the workflow's own log lines in Foreman's style, skipping the bulky record dump. */
function renderLog(msg) {
  if (msg.startsWith('Decision record:') || msg.startsWith('reasonHash=') || msg.startsWith('evidenceHash=') || msg.startsWith('Report written')) return;
  const crit = msg.match(/^Criterion (\d+): met=(true|false|null) \((\w+)\) ?(.*)$/);
  if (crit) {
    const [, n, met, by, why] = crit;
    const mark = met === 'true' ? c.green('met   ') : met === 'false' ? c.red('unmet ') : c.yellow('unsure');
    return ui.out(`    ${c.gray(`${n}.`)} ${mark} ${c.gray(`[${by}]`)} ${ui.clipLine(why, 70)}`);
  }
  if (msg.startsWith('Guardrail')) return ui.warn(msg);
  if (msg.startsWith('Judgment fallback')) return ui.warn(ui.clipLine(msg, 110));
  if (msg.startsWith('Evidence:')) return ui.kv('evidence', ui.clipLine(msg.slice(10), 84));
  if (msg.startsWith('Foreman review:')) return ui.kv('workflow', ui.clipLine(msg.slice(16), 84));
  if (msg.startsWith('Verdict')) return;
  ui.out(`  ${c.gray(msg)}`);
}

// ------------------------------------------------------------ simulation

function creBinary() {
  if (process.env.CRE_BIN) return process.env.CRE_BIN;
  const local = join(homedir(), '.cre', 'bin', 'cre');
  return existsSync(local) ? local : 'cre';
}

/**
 * Run the workflow under a pseudo-TTY (the CLI refuses to run its simulator without one) and stream
 * its log lines. stdin must be /dev/null or `script` intermittently dies with a tcgetattr error.
 * Returns the cleaned full output.
 */
export function runSimulation(payloadPath, { broadcast = true, onLog = () => {} } = {}) {
  const args = [
    '-q', '/dev/null', creBinary(), 'workflow', 'simulate', WORKFLOW,
    '--non-interactive', '--trigger-index', '0', '--http-payload', payloadPath, '--target', 'staging-settings',
    ...(broadcast ? ['--broadcast'] : []),
  ];
  const env = { ...process.env, PATH: `${process.env.PATH}:${join(homedir(), '.bun', 'bin')}:${join(homedir(), '.cre', 'bin')}` };
  return new Promise((resolve, reject) => {
    const child = spawn('script', args, { cwd: CRE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let all = '';
    let pending = '';
    const feed = (buf) => {
      all += buf;
      pending += buf;
      const cut = pending.lastIndexOf('\n');
      if (cut < 0) return;
      for (const line of clean(pending.slice(0, cut + 1)).split('\n')) {
        const msg = userLog(line);
        if (msg !== null) onLog(msg);
      }
      pending = pending.slice(cut + 1);
    };
    child.stdout.on('data', (d) => feed(d.toString()));
    child.stderr.on('data', (d) => feed(d.toString()));
    child.on('error', (e) => reject(new Error(`could not start the CRE simulation: ${e.message}`)));
    child.on('close', (code) => resolve({ code, output: clean(all) }));
  });
}

/** Read the receipt on Arc Testnet and return the ReviewAttested event the receiver emitted, if any. */
export async function readAttestation(receiver, txHash) {
  const client = createPublicClient({ chain: { id: TESTNET.id, name: TESTNET.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [TESTNET.rpc] } } }, transport: http(TESTNET.rpc) });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== receiver.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: RECEIVER_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === 'ReviewAttested') return { ...ev.args, status: receipt.status, block: receipt.blockNumber };
        } catch { /* a log from another event */ }
      }
      return null;
    } catch { await new Promise((r) => setTimeout(r, 1500)); }
  }
  return null;
}

// ---------------------------------------------------------------- command

export async function cmdAttest({ job, index }, { int, need }) {
  const jobId = int(need({ job }, 'job'), 'job');
  const i = int(need({ index }, 'index'), 'index');
  const receiver = JSON.parse(readFileSync(WORKFLOW_CONFIG, 'utf8')).receiverAddress;

  ui.header('attest', `job #${jobId} · milestone ${i + 1} · Chainlink CRE workflow`);
  const j = await chain.readJob(jobId);
  const milestone = (await chain.readMilestones(jobId))[i];
  if (!milestone) throw new Error(`job ${jobId} has no milestone ${i + 1}`);
  const plan = loadPlan(j.termsHash);
  const note = await chain.submittedNote(jobId, i);
  const payload = buildPayload({ jobId, index: i, plan, milestone, note });

  mkdirSync(STATE_DIR, { recursive: true });
  const payloadPath = join(STATE_DIR, `cre-payload-${jobId}-${i}.json`);
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

  ui.kv('milestone', `${plan.plan.milestones[i].name}  (${ui.usdc(milestone.amount)}, ${milestone.statusName}, ${payload.revisionsUsed} revision${payload.revisionsUsed === 1 ? '' : 's'} used)`);
  ui.kv('deliverable', ui.link(payload.deliverableUrl));
  ui.kv('criteria', `${payload.criteria.length} from the signed-off plan`);
  ui.kv('receiver', `${receiver} on ${TESTNET.name}`);
  ui.blank();
  const stop = ui.spinner('running the CRE workflow: evidence, judgment, signed report');
  let started = false;
  const { code, output } = await runSimulation(payloadPath, {
    onLog: (msg) => {
      if (!started) { stop(); started = true; ui.section('Workflow'); }
      renderLog(msg);
    },
  });
  stop();

  const result = parseResult(output);
  if (code !== 0 || !result) {
    const tail = output.split('\n').filter((l) => l.trim()).slice(-8).join('\n');
    throw new Error(`the CRE simulation did not finish (exit ${code}). Last output:\n${tail}`);
  }
  const verdict = VERDICTS[result.verdict] ?? String(result.verdict);
  const txHash = result.txHash;
  const txUrl = `${TESTNET.explorer}/tx/${txHash}`;

  ui.section('Result');
  ui.kv('verdict', `${ui.badge(verdict)} ${c.gray(`via ${result.method}`)}`);
  ui.kv('reasonHash', result.reasonHash);
  ui.kv('evidenceHash', result.evidenceHash);
  ui.kv('tx', ui.link(txUrl));

  const onchain = /^0x0+$/.test(txHash) ? null : await readAttestation(receiver, txHash);
  const matches = Boolean(onchain) && onchain.reasonHash === result.reasonHash && Number(onchain.verdict) === result.verdict;
  if (onchain) ui.ok(matches ? `${c.bold('ReviewAttested')} on ${TESTNET.name}: reasonHash on chain equals the workflow's, block ${onchain.block}` : c.red('ReviewAttested found but does not match the workflow result'));
  else ui.warn('no ReviewAttested event found for this tx');
  if (result.method !== 'gemini') ui.warn('the model was unavailable: this attestation records the deterministic fallback');

  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(ATTESTATIONS_FILE, `${JSON.stringify({
    jobId, index: i, verdict, method: result.method, reasonHash: result.reasonHash, evidenceHash: result.evidenceHash,
    receiver, tx: txHash, explorer: txUrl, chainId: TESTNET.id, mode: 'cre-simulate-broadcast',
    onchainMatch: matches, loggedAt: new Date().toISOString(),
  })}\n`);
  ui.kv('logged', `log/cre-attestations.jsonl`);
  return result;
}
