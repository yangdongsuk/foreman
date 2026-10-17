// Owner opens a Tollgate payment channel to the tool server's provider, with the agent's unfunded
// session key as the voucher signer. Prints `TOLLGATE_CHANNEL=0x...` (eval-able) on the last line.
//
//   OWNER_KEY=0x.. SESSION_ADDRESS=0x.. PROVIDER_ADDRESS=0x.. DEPOSIT_USDC=1 node scripts/open-channel.mjs
//
// Optional: GRACE_SECONDS (default 600). RPC_URL / CHAIN_ID / TOLLGATE / USDC point it at a local node.
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, ADDR, FEES, RPC_URL, toUnits, fmtUSDC, txUrl } from '../lib/config.mjs';
import { TOLLGATE_ABI } from '../vendor/tollgate.mjs';

const need = (k) => {
  if (!process.env[k]) { console.error(`${k} is required`); process.exit(1); }
  return process.env[k];
};
const key = need('OWNER_KEY');
const session = need('SESSION_ADDRESS');
const provider = need('PROVIDER_ADDRESS');
const deposit = toUnits(need('DEPOSIT_USDC'));
const grace = BigInt(process.env.GRACE_SECONDS || 600);

const owner = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const wallet = createWalletClient({ chain, transport: http(RPC_URL), account: owner });
const abi = parseAbi([
  'function open(address provider, address signer, address token, uint128 amount, uint64 grace) returns (bytes32)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const send = async (address, functionName, args) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args, ...FEES });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${txUrl(hash)})`);
  console.error(`${functionName}: ${txUrl(hash)}`);
  return receipt;
};

const balance = await pub.readContract({ address: ADDR.USDC, abi, functionName: 'balanceOf', args: [owner.address] });
if (balance < deposit) throw new Error(`owner holds ${fmtUSDC(balance)} USDC, needs ${fmtUSDC(deposit)}`);

await send(ADDR.USDC, 'approve', [ADDR.TOLLGATE, deposit]);
const receipt = await send(ADDR.TOLLGATE, 'open', [provider, session, ADDR.USDC, deposit, grace]);
const [opened] = parseEventLogs({ abi: TOLLGATE_ABI, logs: receipt.logs, eventName: 'ChannelOpened' });
console.error(`channel opened: ${fmtUSDC(deposit)} USDC to ${provider}, signer ${session}`);
console.log(`TOLLGATE_CHANNEL=${opened.args.channelId}`);
