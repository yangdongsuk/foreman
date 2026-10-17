// Client for the pay-per-call tool server. Every call is paid with a Tollgate voucher signed by the
// session key (an unfunded key: its worst case is the channel balance, never the owner's wallet).
import { privateKeyToAccount } from 'viem/accounts';
import { Meter, HEADER, TOLLGATE_ABI } from '../vendor/tollgate.mjs';
import { chain, ADDR } from '../lib/config.mjs';
import { publicClient } from './chain.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR } from './paths.mjs';

const METER_FILE = join(STATE_DIR, 'meter.json');

export class ToolError extends Error {
  constructor(message, { status, paid = false } = {}) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
    this.paid = paid; // true when a voucher was accepted before the failure (money was spent)
  }
}

export class ToolClient {
  constructor({
    url = process.env.TOOLS_URL || 'http://localhost:8790',
    sessionKey = process.env.SESSION_KEY,
    channelId = process.env.TOLLGATE_CHANNEL,
    tollgate = ADDR.TOLLGATE,
    meterFile = METER_FILE,
    timeoutMs = 30_000,
  } = {}) {
    this.url = url.replace(/\/$/, '');
    this.channelId = channelId;
    this.tollgate = tollgate;
    this.meterFile = meterFile;
    this.timeoutMs = timeoutMs;
    this.sessionKey = sessionKey;
    this.meter = null;
    this.tools = null;
  }

  get ready() { return Boolean(this.sessionKey && this.channelId); }
  get stateKey() { return `${chain.id}:${this.tollgate}:${this.channelId}`; }

  // The cumulative total lives on disk so a restart never re-signs a lower amount.
  #loadTotal() {
    try { return BigInt(JSON.parse(readFileSync(this.meterFile, 'utf8'))[this.stateKey] ?? 0); } catch { return 0n; }
  }
  #saveTotal(total) {
    let all = {};
    try { all = JSON.parse(readFileSync(this.meterFile, 'utf8')); } catch { /* first write */ }
    all[this.stateKey] = total.toString();
    mkdirSync(dirname(this.meterFile), { recursive: true });
    writeFileSync(this.meterFile, JSON.stringify(all, null, 1));
  }

  #meter() {
    if (!this.ready) throw new ToolError('tool payments are not configured (set SESSION_KEY and TOLLGATE_CHANNEL)');
    if (!this.meter) {
      const key = this.sessionKey.startsWith('0x') ? this.sessionKey : `0x${this.sessionKey}`;
      this.meter = new Meter({
        account: privateKeyToAccount(key), contract: this.tollgate, channelId: this.channelId,
        chainId: chain.id, cumulative: this.#loadTotal(),
      });
    }
    return this.meter;
  }

  /** The priced tool catalog (free endpoint). Throws ToolError when the server is unreachable. */
  async catalog() {
    let res;
    try {
      res = await fetch(`${this.url}/tools`, { signal: AbortSignal.timeout(8000) });
    } catch (e) {
      throw new ToolError(`tool server unreachable at ${this.url} (${e.cause?.code || e.message})`);
    }
    if (!res.ok) throw new ToolError(`tool server answered ${res.status} for /tools`, { status: res.status });
    const body = await res.json();
    this.tools = (body.tools || []).map((t) => ({ ...t, price: BigInt(t.price) }));
    this.provider = body.provider;
    return this.tools;
  }

  /** On-chain channel balance minus what this client has already signed away. */
  async budget() {
    if (!this.ready) return { deposit: 0n, redeemed: 0n, signed: 0n, remaining: 0n };
    const [, , , , deposit, redeemed] = await publicClient.readContract({
      address: this.tollgate, abi: TOLLGATE_ABI, functionName: 'channels', args: [this.channelId],
    });
    const signed = this.#meter().cumulative;
    const used = signed > redeemed ? signed : redeemed;
    return { deposit, redeemed, signed, remaining: deposit > used ? deposit - used : 0n };
  }

  /**
   * Pay for and execute one tool call.
   * Returns { result, receipt, priceUnits }; throws ToolError otherwise.
   */
  async call(name, args = {}) {
    const tool = (this.tools || (await this.catalog())).find((t) => t.name === name);
    if (!tool) throw new ToolError(`unknown tool "${name}"`);
    const meter = this.#meter();
    let price = tool.price;

    const b = await this.budget();
    if (price > b.remaining) throw new ToolError(`channel balance too low for ${name} (${price} > ${b.remaining})`);

    for (let attempt = 0; attempt < 2; attempt++) {
      const before = meter.cumulative;
      const voucher = await meter.pay(price);
      this.#saveTotal(meter.cumulative); // write-ahead: never reuse a signed amount
      let res;
      try {
        res = await this.#request(tool, args, voucher);
      } catch (e) {
        // Unknown whether the provider counted the voucher; keep the spend to stay on the safe side.
        throw new ToolError(`${name} request failed: ${e.cause?.code || e.message}`, { paid: true });
      }
      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        const receipt = body.receipt || { channelId: this.channelId, cumulative: meter.cumulative.toString(), price: price.toString() };
        const { receipt: _r, ...result } = body;
        return { result, receipt: { ...receipt, cumulative: String(receipt.cumulative), price: String(receipt.price) }, priceUnits: price };
      }
      if (res.status !== 402) {
        // The provider accepted the voucher before failing, so the spend stands.
        throw new ToolError(`${name} failed: ${res.status} ${body.error || ''}`.trim(), { status: res.status, paid: true });
      }

      // 402: the voucher was rejected, so nothing was spent. Roll the meter back, then fix the cause once.
      meter.cumulative = before;
      this.#saveTotal(before);
      const resync = /at least (\d+)/.exec(body.error || '');
      if (attempt === 0 && resync) {
        meter.cumulative = BigInt(resync[1]) - price; // provider is ahead of our state file: resume from its total
      } else if (attempt === 0 && body.payment?.price) {
        price = BigInt(body.payment.price); // terms changed: re-read once
      } else {
        throw new ToolError(`payment rejected for ${name}: ${body.error || res.status}`, { status: 402 });
      }
    }
    throw new ToolError(`payment rejected for ${name}`, { status: 402 });
  }

  #request(tool, args, voucher) {
    const headers = { [HEADER]: voucher, accept: 'application/json' };
    const signal = AbortSignal.timeout(this.timeoutMs);
    if (tool.method === 'POST') {
      return fetch(`${this.url}${tool.path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(args), signal });
    }
    const qs = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString();
    return fetch(`${this.url}${tool.path}${qs ? `?${qs}` : ''}`, { headers, signal });
  }
}
