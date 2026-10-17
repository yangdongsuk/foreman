// Tollgate SDK: sign, encode and verify pay-per-call vouchers for Tollgate channels on Arc.
// Works in Node and the browser (only depends on viem).
import { defineChain, recoverTypedDataAddress, isAddressEqual, parseAbi } from 'viem';

export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
});

export const USDC = '0x3600000000000000000000000000000000000000'; // ERC-20 interface, 6 decimals
export const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
export const HEADER = 'x-tollgate-voucher';

export const TOLLGATE_ABI = parseAbi([
  'function channels(bytes32) view returns (address payer, address provider, address signer, address token, uint128 deposit, uint128 redeemed, uint64 grace, uint64 closeRequestedAt, bool closed)',
  'function redeem(bytes32 channelId, uint256 cumulativeAmount, bytes signature)',
  'function available(bytes32 channelId) view returns (uint256)',
  'function voucherDigest(bytes32 channelId, uint256 cumulativeAmount) view returns (bytes32)',
  'event ChannelOpened(bytes32 indexed channelId, address indexed payer, address indexed provider, address signer, address token, uint256 deposit, uint64 grace)',
  'event CloseRequested(bytes32 indexed channelId, uint256 closableAt)',
]);

const types = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
  ],
};

const domain = (contract, chainId) => ({ name: 'Tollgate', version: '1', chainId, verifyingContract: contract });

/** Sign "I owe `cumulative` in total on this channel". `account` is a viem local account or wallet client account. */
export async function signVoucher({ account, contract, chainId = arc.id, channelId, cumulative }) {
  const signature = await account.signTypedData({
    domain: domain(contract, chainId),
    types,
    primaryType: 'Voucher',
    message: { channelId, cumulativeAmount: BigInt(cumulative) },
  });
  return { channelId, cumulative: BigInt(cumulative), signature };
}

export async function recoverVoucherSigner({ contract, chainId = arc.id, channelId, cumulative, signature }) {
  return recoverTypedDataAddress({
    domain: domain(contract, chainId),
    types,
    primaryType: 'Voucher',
    message: { channelId, cumulativeAmount: BigInt(cumulative) },
    signature,
  });
}

export const encodeVoucher = (v) => `${v.channelId}:${v.cumulative.toString()}:${v.signature}`;

export function decodeVoucher(header) {
  const [channelId, cumulative, signature] = String(header || '').split(':');
  if (!/^0x[0-9a-fA-F]{64}$/.test(channelId || '') || !/^\d+$/.test(cumulative || '') || !/^0x[0-9a-fA-F]{130}$/.test(signature || '')) {
    return null;
  }
  return { channelId, cumulative: BigInt(cumulative), signature };
}

/**
 * Payer side: keeps the running total for one channel and produces the header for the next call.
 * Persist `cumulative` if the agent restarts, or it will re-sign lower totals the provider rejects.
 */
export class Meter {
  constructor({ account, contract, channelId, chainId = arc.id, cumulative = 0n }) {
    Object.assign(this, { account, contract, channelId, chainId, cumulative: BigInt(cumulative) });
  }

  async pay(price) {
    const next = this.cumulative + BigInt(price);
    const v = await signVoucher({ account: this.account, contract: this.contract, chainId: this.chainId, channelId: this.channelId, cumulative: next });
    this.cumulative = next;
    return encodeVoucher(v);
  }
}

/**
 * Provider side: validates vouchers against on-chain channel state and remembers the best one
 * per channel so it can be redeemed later in a single transaction.
 */
export class Gate {
  constructor({ publicClient, contract, provider, chainId = arc.id, token = USDC }) {
    Object.assign(this, { publicClient, contract, provider, chainId, token });
    this.latest = new Map(); // channelId -> { cumulative, signature }
    this.cache = new Map(); // channelId -> { channel, at }
  }

  async channel(channelId, maxAgeMs = 15_000) {
    const hit = this.cache.get(channelId);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.channel;
    const [payer, provider, signer, token, deposit, redeemed, grace, closeRequestedAt, closed] =
      await this.publicClient.readContract({ address: this.contract, abi: TOLLGATE_ABI, functionName: 'channels', args: [channelId] });
    const channel = { payer, provider, signer, token, deposit, redeemed, grace, closeRequestedAt, closed };
    this.cache.set(channelId, { channel, at: Date.now() });
    return channel;
  }

  /** Returns { ok: true, voucher } or { ok: false, status, error } for an incoming header and price. */
  async check(header, price) {
    const v = decodeVoucher(header);
    if (!v) return { ok: false, status: 402, error: 'missing or malformed voucher' };
    const c = await this.channel(v.channelId);
    if (c.payer === '0x0000000000000000000000000000000000000000') return { ok: false, status: 402, error: 'unknown channel' };
    if (c.closed || c.closeRequestedAt !== 0n) return { ok: false, status: 402, error: 'channel is closing' };
    if (!isAddressEqual(c.provider, this.provider)) return { ok: false, status: 402, error: 'channel is for another provider' };
    if (!isAddressEqual(c.token, this.token)) return { ok: false, status: 402, error: 'wrong currency' };
    const prev = this.latest.get(v.channelId)?.cumulative ?? c.redeemed;
    if (v.cumulative < prev + BigInt(price)) return { ok: false, status: 402, error: `voucher must be at least ${prev + BigInt(price)}` };
    if (v.cumulative > c.deposit) return { ok: false, status: 402, error: 'channel balance exhausted, top up' };
    const signer = await recoverVoucherSigner({ contract: this.contract, chainId: this.chainId, ...v });
    if (!isAddressEqual(signer, c.signer)) return { ok: false, status: 402, error: 'bad signature' };
    this.latest.set(v.channelId, { cumulative: v.cumulative, signature: v.signature });
    return { ok: true, voucher: v };
  }

  /** Unredeemed amount per channel, useful to decide when a redemption is worth its gas. */
  pending() {
    return [...this.latest.entries()].map(([channelId, v]) => ({ channelId, ...v }));
  }

  /** Redeem the best voucher for a channel. `walletClient` must be able to pay gas on Arc. */
  async redeem(walletClient, channelId, fees = {}) {
    const v = this.latest.get(channelId);
    if (!v) return null;
    const hash = await walletClient.writeContract({
      address: this.contract, abi: TOLLGATE_ABI, functionName: 'redeem',
      args: [channelId, v.cumulative, v.signature], chain: walletClient.chain, ...fees,
    });
    this.cache.delete(channelId);
    return hash;
  }
}
