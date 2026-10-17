// Chain access for the agent: viem clients, reads, and every write Foreman performs.
// Each write is simulated first so a revert surfaces as a named custom error (e.g. OverAutoApproveCap)
// instead of an opaque failure, then sent with FEES and awaited.
import { createPublicClient, createWalletClient, http, parseEventLogs, BaseError, ContractFunctionRevertedError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, ADDR, FEES, POLICY_ABI, STAGEPAY_ABI, ERC20_ABI, STATUS, txUrl, RPC_URL } from '../lib/config.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR } from './paths.mjs';

const LOG_CHUNK = 5000n; // Arc RPC limit for eth_getLogs ranges
const CHAIN_IS_LOCAL = chain.id !== 5042;

// Stagepay errors bubble up through the policy contract, so decode against both ABIs.
const DECODE_ABI = [...POLICY_ABI, ...STAGEPAY_ABI.filter((x) => x.type === 'error')];

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

export class ChainError extends Error {
  constructor(message, errorName) {
    super(message);
    this.name = 'ChainError';
    this.errorName = errorName;
  }
}

export function policyAddress() {
  if (!ADDR.POLICY) throw new ChainError('FOREMAN_POLICY is not set (deploy ForemanPolicy and export its address)');
  return ADDR.POLICY;
}

// ---------------------------------------------------------------- wallets

const wallets = new Map();

/** role: 'OWNER' | 'AGENT' | 'FREELANCER' -> { account, client } built from `<role>_KEY`. */
export function wallet(role) {
  if (!wallets.has(role)) {
    const key = process.env[`${role}_KEY`];
    if (!key) throw new ChainError(`${role}_KEY is not set (source ~/.config/foreman/keys.env)`);
    const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
    wallets.set(role, { account, client: createWalletClient({ account, chain, transport: http(RPC_URL) }) });
  }
  return wallets.get(role);
}

export const addressOf = (role) => wallet(role).account.address;

function revertName(e) {
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError) return hit.data?.errorName || hit.reason || 'revert';
  }
  return null;
}

async function send(role, { address, abi, functionName, args }) {
  const { account, client } = wallet(role);
  let request;
  try {
    ({ request } = await publicClient.simulateContract({ address, abi: abi === POLICY_ABI ? DECODE_ABI : abi, functionName, args, account, ...FEES }));
  } catch (e) {
    const name = revertName(e);
    throw new ChainError(name ? `${functionName} reverted: ${name}` : `${functionName} failed: ${e.shortMessage || e.message}`, name);
  }
  const hash = await client.writeContract({ ...request, ...FEES });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new ChainError(`${functionName} reverted on chain (${hash})`, 'revert');
  return { hash, url: txUrl(hash), receipt };
}

const policyWrite = (role, functionName, args) => send(role, { address: policyAddress(), abi: POLICY_ABI, functionName, args });

// ------------------------------------------------------------------ reads

export async function chainNow() {
  return Number((await publicClient.getBlock()).timestamp);
}

export async function readJob(jobId) {
  const [client, freelancer, token, reviewPeriod, termsHash, total, settled] =
    await publicClient.readContract({ address: ADDR.STAGEPAY, abi: STAGEPAY_ABI, functionName: 'jobs', args: [BigInt(jobId)] });
  if (client === '0x0000000000000000000000000000000000000000') throw new ChainError(`job ${jobId} does not exist`);
  return { jobId: Number(jobId), client, freelancer, token, reviewPeriod: Number(reviewPeriod), termsHash, total, settled };
}

export async function readMilestones(jobId) {
  const ms = await publicClient.readContract({ address: ADDR.STAGEPAY, abi: STAGEPAY_ABI, functionName: 'getMilestones', args: [BigInt(jobId)] });
  return ms.map((m, index) => ({
    index,
    amount: m.amount,
    deadline: Number(m.deadline),
    submittedAt: Number(m.submittedAt),
    status: m.status,
    statusName: STATUS[m.status],
    revisions: m.revisions,
  }));
}

export async function readPolicy() {
  const address = policyAddress();
  const read = (functionName) => publicClient.readContract({ address, abi: POLICY_ABI, functionName });
  const [owner, agent, autoApproveCap, dailyCap, paused, spentToday, remainingToday] = await Promise.all(
    ['owner', 'agent', 'autoApproveCap', 'dailyCap', 'paused', 'spentToday', 'remainingToday'].map(read),
  );
  return { address, owner, agent, autoApproveCap, dailyCap, paused, spentToday, remainingToday };
}

export const isEscalated = (jobId, index) =>
  publicClient.readContract({ address: policyAddress(), abi: POLICY_ABI, functionName: 'escalated', args: [BigInt(jobId), BigInt(index)] });

export const isManaged = (jobId) =>
  publicClient.readContract({ address: policyAddress(), abi: POLICY_ABI, functionName: 'managed', args: [BigInt(jobId)] });

export async function tokenBalance(token, who) {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] });
}

// ------------------------------------------------------- submission notes

const NOTES_FILE = join(STATE_DIR, 'notes.json');
const readCache = () => { try { return JSON.parse(readFileSync(NOTES_FILE, 'utf8')); } catch { return {}; } };

async function deployBlock() {
  if (process.env.POLICY_DEPLOY_BLOCK) return BigInt(process.env.POLICY_DEPLOY_BLOCK);
  if (CHAIN_IS_LOCAL) return 0n;
  // Mainnet without a hint: binary-search the first block where the policy has code.
  const address = policyAddress();
  let lo = 0n, hi = await publicClient.getBlockNumber();
  try {
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const code = await publicClient.getCode({ address, blockNumber: mid });
      if (code && code !== '0x') hi = mid; else lo = mid + 1n;
    }
    return lo;
  } catch {
    return 0n;
  }
}
/**
 * Latest `MilestoneSubmitted` note for a milestone. Scans backwards from the chain head in
 * 5,000-block chunks (the newest submission is almost always near the head) and stops at the
 * policy's deploy block. Results are cached per submission in state/notes.json.
 */
export async function submittedNote(jobId, index) {
  const m = (await readMilestones(jobId))[index];
  const cacheKey = `${chain.id}:${ADDR.STAGEPAY}:${jobId}:${index}:${m?.submittedAt}`;
  const cache = readCache();
  if (cache[cacheKey] !== undefined) return cache[cacheKey];

  const floor = await deployBlock();
  const head = await publicClient.getBlockNumber();
  for (let to = head; ; to = to - LOG_CHUNK - 1n) {
    const from = to - LOG_CHUNK + 1n > floor ? to - LOG_CHUNK + 1n : floor;
    const logs = await publicClient.getContractEvents({
      address: ADDR.STAGEPAY, abi: STAGEPAY_ABI, eventName: 'MilestoneSubmitted',
      args: { jobId: BigInt(jobId), index: BigInt(index) }, fromBlock: from, toBlock: to,
    });
    if (logs.length) {
      const note = logs[logs.length - 1].args.note;
      mkdirSync(dirname(NOTES_FILE), { recursive: true });
      writeFileSync(NOTES_FILE, JSON.stringify({ ...cache, [cacheKey]: note }, null, 1));
      return note;
    }
    if (from <= floor) return null;
  }
}

// ----------------------------------------------------------------- writes

/** plan: { freelancer, token, amounts: bigint[], deadlines: bigint[], reviewPeriod, termsHash } -> { jobId, hash, url } */
export async function fundJob(plan) {
  const total = plan.amounts.reduce((a, b) => a + b, 0n);
  const approval = await send('OWNER', { address: plan.token, abi: ERC20_ABI, functionName: 'approve', args: [policyAddress(), total] });
  const res = await policyWrite('OWNER', 'fundJob', [
    plan.freelancer, plan.token, plan.amounts, plan.deadlines.map(BigInt), BigInt(plan.reviewPeriod), plan.termsHash,
  ]);
  const [funded] = parseEventLogs({ abi: POLICY_ABI, eventName: 'JobFunded', logs: res.receipt.logs });
  return { ...res, jobId: Number(funded.args.jobId), approvalTx: approval.hash, total };
}

export const agentApprove = (jobId, index, reasonHash) => policyWrite('AGENT', 'agentApprove', [BigInt(jobId), BigInt(index), reasonHash]);
export const agentRequestRevision = (jobId, index, note, reasonHash) => policyWrite('AGENT', 'agentRequestRevision', [BigInt(jobId), BigInt(index), note, reasonHash]);
export const agentEscalate = (jobId, index, reasonHash) => policyWrite('AGENT', 'agentEscalate', [BigInt(jobId), BigInt(index), reasonHash]);
export const ownerCosign = (jobId, index) => policyWrite('OWNER', 'ownerCosign', [BigInt(jobId), BigInt(index)]);
export const setPaused = (paused) => policyWrite('OWNER', 'setPaused', [paused]);
export const freelancerSubmit = (jobId, index, note) =>
  send('FREELANCER', { address: ADDR.STAGEPAY, abi: STAGEPAY_ABI, functionName: 'submit', args: [BigInt(jobId), BigInt(index), note] });
