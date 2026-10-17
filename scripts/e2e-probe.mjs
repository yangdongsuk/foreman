// Tiny read-only probes used by scripts/local-e2e.sh to assert on-chain state. Prints one value to stdout.
//   milestone <jobId> <index>      -> Stagepay status name (Funded, Submitted, Released, ...)
//   escalated <jobId> <index>      -> true | false
//   agent-approve <jobId> <index>  -> revert error name when the AGENT key simulates agentApprove, or "ok"
//   balance <address>              -> USDC units (ERC-20 interface)
//   job-count                      -> number of jobs managed by the policy
//   tollgate-redeemed <channelId>  -> units redeemed on chain for the channel
import { createPublicClient, http, BaseError, ContractFunctionRevertedError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, ADDR, RPC_URL, POLICY_ABI, ERC20_ABI } from '../lib/config.mjs';
import { readMilestones, isEscalated } from '../agent/chain.mjs';
import { TOLLGATE_ABI } from '../vendor/tollgate.mjs';

const [cmd, a, b] = process.argv.slice(2);
const pub = createPublicClient({ chain, transport: http(RPC_URL) });

switch (cmd) {
  case 'milestone': console.log((await readMilestones(a))[Number(b)].statusName); break;
  case 'escalated': console.log(String(await isEscalated(a, b))); break;
  case 'job-count': console.log(String(await pub.readContract({ address: ADDR.POLICY, abi: POLICY_ABI, functionName: 'jobCount' }))); break;
  case 'balance': console.log(String(await pub.readContract({ address: ADDR.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] }))); break;
  case 'tollgate-redeemed': {
    const ch = await pub.readContract({ address: ADDR.TOLLGATE, abi: TOLLGATE_ABI, functionName: 'channels', args: [a] });
    console.log(String(ch[5]));
    break;
  }
  case 'agent-approve': {
    const account = privateKeyToAccount(process.env.AGENT_KEY);
    try {
      await pub.simulateContract({ account, address: ADDR.POLICY, abi: POLICY_ABI, functionName: 'agentApprove', args: [BigInt(a), BigInt(b), `0x${'00'.repeat(32)}`] });
      console.log('ok');
    } catch (e) {
      const hit = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError);
      console.log(hit?.data?.errorName || `unknown: ${e.shortMessage || e.message}`);
    }
    break;
  }
  default: console.error('unknown probe'); process.exit(2);
}
