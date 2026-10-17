// Shared chain config for every Foreman component (agent, tools server, scripts).
// Addresses can be overridden with env vars so the same code runs against a local anvil node.
import { defineChain, parseAbi, parseGwei } from 'viem';
import { STAGEPAY_ABI, ERC20_ABI } from './stagepay-abi.js';

export { STAGEPAY_ABI, ERC20_ABI };

const env = (k, d) => (process.env[k] && process.env[k].length ? process.env[k] : d);

export const CHAIN_ID = Number(env('CHAIN_ID', 5042));
export const RPC_URL = env('RPC_URL', 'https://rpc.mainnet.arc.io');
export const EXPLORER = env('EXPLORER', 'https://explorer.arc.io');

export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 5042 ? 'Arc' : `local-${CHAIN_ID}`,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: EXPLORER } },
});

export const ADDR = {
  STAGEPAY: env('STAGEPAY', '0x0A87039a127b600cF9B85d4C33d97c08054e15E6'),
  TOLLGATE: env('TOLLGATE', '0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F'),
  USDC: env('USDC', '0x3600000000000000000000000000000000000000'), // ERC-20 interface, 6 decimals
  EURC: env('EURC', '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'),
  POLICY: env('FOREMAN_POLICY', ''), // set after `forge script contracts/script/Deploy.s.sol`
};

// Arc drops transactions below its 20 gwei base-fee floor; local anvil accepts anything.
export const FEES = CHAIN_ID === 5042
  ? { maxFeePerGas: parseGwei('40'), maxPriorityFeePerGas: parseGwei('1') }
  : {};

export const USDC_DECIMALS = 6;
export const fmtUSDC = (units) => (Number(units) / 1e6).toFixed(6).replace(/\.?0+$/, '');
export const toUnits = (usdc) => BigInt(Math.round(Number(usdc) * 1e6));
export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const addrUrl = (a) => `${EXPLORER}/address/${a}`;

// Milestone.status values in Stagepay (enum starts with None, so Submitted = 2).
export const STATUS = ['None', 'Funded', 'Submitted', 'Released', 'Refunded', 'Split'];
export const SUBMITTED = 2;

// ForemanPolicy ABI. contracts/src/ForemanPolicy.sol MUST match this exactly (see SPEC.md).
export const POLICY_ABI = parseAbi([
  'constructor(address stagepay, address agent, uint128 autoApproveCap, uint128 dailyCap)',
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function stagepay() view returns (address)',
  'function autoApproveCap() view returns (uint128)',
  'function dailyCap() view returns (uint128)',
  'function paused() view returns (bool)',
  'function managed(uint256 jobId) view returns (bool)',
  'function escalated(uint256 jobId, uint256 index) view returns (bool)',
  'function jobCount() view returns (uint256)',
  'function jobAt(uint256 i) view returns (uint256)',
  'function spentToday() view returns (uint256)',
  'function remainingToday() view returns (uint256)',
  'function releasedOnDay(uint256 day) view returns (uint256)',
  'function fundJob(address freelancer, address token, uint128[] amounts, uint64[] deadlines, uint64 reviewPeriod, bytes32 termsHash) returns (uint256 jobId)',
  'function agentApprove(uint256 jobId, uint256 index, bytes32 reasonHash)',
  'function agentRequestRevision(uint256 jobId, uint256 index, string note, bytes32 reasonHash)',
  'function agentEscalate(uint256 jobId, uint256 index, bytes32 reasonHash)',
  'function ownerCosign(uint256 jobId, uint256 index)',
  'function ownerApprove(uint256 jobId, uint256 index)',
  'function ownerRequestRevision(uint256 jobId, uint256 index, string note)',
  'function ownerCancelExpired(uint256 jobId, uint256 index)',
  'function ownerProposeSplit(uint256 jobId, uint256 index, uint128 toFreelancer)',
  'function ownerAcceptSplit(uint256 jobId, uint256 index, uint128 toFreelancer)',
  'function withdraw(address token, address to, uint256 amount)',
  'function setLimits(uint128 autoApproveCap, uint128 dailyCap)',
  'function setAgent(address agent)',
  'function setPaused(bool paused)',
  'event JobFunded(uint256 indexed jobId, address indexed freelancer, address token, uint256 total, bytes32 termsHash)',
  'event AgentDecision(uint256 indexed jobId, uint256 indexed index, uint8 action, uint256 amount, bytes32 reasonHash)',
  'event Escalated(uint256 indexed jobId, uint256 indexed index, uint256 amount, bytes32 reasonHash)',
  'event OwnerCosigned(uint256 indexed jobId, uint256 indexed index, uint256 amount)',
  'event LimitsSet(uint128 autoApproveCap, uint128 dailyCap)',
  'event AgentSet(address agent)',
  'event PausedSet(bool paused)',
  'error NotOwner()',
  'error NotAgent()',
  'error IsPaused()',
  'error NotManaged()',
  'error NotSubmitted()',
  'error OverAutoApproveCap()',
  'error OverDailyCap()',
  'error NotEscalated()',
  'error InvalidParams()',
]);

// AgentDecision.action values.
export const ACTION = { APPROVE: 0, REQUEST_REVISION: 1, ESCALATE: 2 };
export const ACTION_NAME = ['approve', 'request_revision', 'escalate'];
