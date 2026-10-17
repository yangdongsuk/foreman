// Dashboard configuration. Everything the page reads from chain is derived from these values.
// Fill POLICY / POLICY_DEPLOY_BLOCK / TOOLS_CHANNEL after deploying (see README); until POLICY is set
// the page renders a "not deployed yet" state and shows the sample decision log.
//
// For local testing you can override any value from the URL without editing this file, e.g.
//   index.html?policy=0xABC...&block=123&rpc=http://127.0.0.1:8545&chain=5042&channel=0x...
const q = new URLSearchParams(globalThis.location?.search ?? '');
const pick = (key, fallback) => q.get(key) || fallback;

export const CHAIN_ID = Number(pick('chain', 5042));
export const RPC = pick('rpc', 'https://rpc.mainnet.arc.io');
export const EXPLORER = pick('explorer', 'https://explorer.arc.io');

// ForemanPolicy deployment (empty string = not deployed yet).
export const POLICY = pick('policy', '0x2065a64a410E0610ebD654b4eC4ADE142e9A68E2');
// Block of the ForemanPolicy deployment; log scans start here (keep it exact, Arc blocks are sub-second).
export const POLICY_DEPLOY_BLOCK = Number(pick('block', 26454642));
// Tollgate channel id (bytes32) that pays for the agent's tools; empty = skip the tool-spend card.
export const TOOLS_CHANNEL = pick('channel', '0x4a812a137c3fc2ba927bafd8df8edc0b155d13966939cfdb594306a994952289');

// Contracts already live on Arc mainnet.
export const STAGEPAY = pick('stagepay', '0x0A87039a127b600cF9B85d4C33d97c08054e15E6');
export const TOLLGATE = pick('tollgate', '0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F');

// Token display info (USDC ERC-20 interface has 6 decimals; native gas balance is the same USDC at 18).
export const TOKENS = {
  '0x3600000000000000000000000000000000000000': { symbol: 'USDC', decimals: 6 },
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': { symbol: 'EURC', decimals: 6 },
};

// Where the agent writes its decision records (static file next to index.html).
export const DECISIONS_URL = 'data/decisions.json';
export const REPO_URL = 'https://github.com/yangdongsuk/foreman';
