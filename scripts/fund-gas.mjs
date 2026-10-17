// Top up the agent, provider and freelancer keys with a little native USDC for gas, and print balances.
// The agent's session key gets nothing on purpose: it only signs Tollgate vouchers.
//
//   source ~/.config/foreman/keys.env && OWNER_KEY=0x... node scripts/fund-gas.mjs            # balances only
//   source ~/.config/foreman/keys.env && OWNER_KEY=0x... node scripts/fund-gas.mjs --send     # top up to targets
import { createPublicClient, createWalletClient, formatEther, http, parseEther, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, ADDR, FEES, RPC_URL } from '../lib/config.mjs';

const owner = privateKeyToAccount(process.env.OWNER_KEY);
const targets = {
  AGENT: parseEther(process.env.AGENT_GAS || '0.06'),
  PROVIDER: parseEther(process.env.PROVIDER_GAS || '0.03'),
  FREELANCER: parseEther(process.env.FREELANCER_GAS || '0.03'),
};
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const wallet = createWalletClient({ chain, transport: http(RPC_URL), account: owner });

async function show() {
  const rows = [['OWNER', owner.address], ...['AGENT', 'SESSION', 'PROVIDER', 'FREELANCER'].map((r) => [r, process.env[`${r}_ADDRESS`]])];
  for (const [role, addr] of rows) {
    const native = await pub.getBalance({ address: addr });
    const usdc = await pub.readContract({ address: ADDR.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
    console.log(`${role.padEnd(10)} ${addr}  native ${formatEther(native).padEnd(22)} usdc(erc20) ${(Number(usdc) / 1e6).toFixed(6)}`);
  }
}

await show();
if (process.argv.includes('--send')) {
  for (const [role, target] of Object.entries(targets)) {
    const to = process.env[`${role}_ADDRESS`];
    const have = await pub.getBalance({ address: to });
    if (have >= target) continue;
    const hash = await wallet.sendTransaction({ to, value: target - have, ...FEES });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`topped up ${role} by ${formatEther(target - have)} → ${r.status} ${hash}`);
  }
  await show();
}
