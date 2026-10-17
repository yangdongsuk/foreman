// Redeems the best voucher per channel on chain. One redemption at a time so provider nonces never collide.
import fs from 'node:fs';
import path from 'node:path';
import { fmtUSDC, txUrl } from '../lib/config.mjs';

export function createRedeemer({ gate, publicClient, walletClient, redeemAt, fees, logFile }) {
  const redeemedUpTo = new Map(); // channelId -> cumulative we redeemed (avoids an RPC read per call)
  let queue = Promise.resolve();

  async function redeemChannel(channelId, cumulative, { force, checkClosing }) {
    let done = redeemedUpTo.get(channelId);
    let closing = false;
    if (done === undefined || checkClosing) {
      const c = await gate.channel(channelId, 0);
      done ??= c.redeemed;
      redeemedUpTo.set(channelId, done);
      closing = c.closeRequestedAt !== 0n;
    }
    const owed = cumulative - done;
    if (owed <= 0n) return null;
    // A closing channel is redeemed at once: the payer can reclaim the rest after the grace period.
    if (!force && !closing && owed < redeemAt) return null;

    const hash = await gate.redeem(walletClient, channelId, fees);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`redeem reverted (${hash})`);
    redeemedUpTo.set(channelId, cumulative);

    const entry = { ts: new Date().toISOString(), channelId, cumulative: cumulative.toString(), tx: hash };
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    console.log(`redeemed ${fmtUSDC(owed)} USDC on ${channelId.slice(0, 10)}… (cumulative ${fmtUSDC(cumulative)})  ${txUrl(hash)}`);
    return { ...entry, redeemedUnits: owed.toString(), explorer: txUrl(hash) };
  }

  /** Redeem every channel that is owed enough (or anything owed, with `force`). Resolves to the list of redemptions. */
  function run({ force = false, checkClosing = false } = {}) {
    const job = queue.then(async () => {
      const done = [];
      const errors = [];
      for (const { channelId, cumulative } of gate.pending()) {
        try {
          const r = await redeemChannel(channelId, cumulative, { force, checkClosing });
          if (r) done.push(r);
        } catch (e) {
          // Drop the cached state so the next attempt re-reads the chain.
          redeemedUpTo.delete(channelId);
          errors.push({ channelId, error: e.shortMessage || e.message });
          console.error(`redeem failed for ${channelId.slice(0, 10)}…: ${e.shortMessage || e.message}`);
        }
      }
      return { redeemed: done, errors };
    });
    queue = job.catch(() => {});
    return job;
  }

  return { run, owed: () => gate.pending().map(({ channelId, cumulative }) => ({ channelId, cumulative, redeemed: redeemedUpTo.get(channelId) ?? null })) };
}
