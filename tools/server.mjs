// Foreman tool server: a priced catalog of evidence tools, each call paid with a Tollgate voucher.
//
//   PROVIDER_KEY=0x... node tools/server.mjs        (PORT default 8790, REDEEM_AT default 5000 = 0.005 USDC)
//
// Paid endpoints need an `x-tollgate-voucher` header worth at least `price` more than the previous one on
// the same channel, otherwise they answer HTTP 402 with the payment terms. Vouchers are redeemed on chain
// in batches: when REDEEM_AT is owed, on POST /admin/redeem (localhost only) and on shutdown.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http as rpc } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Gate, HEADER } from '../vendor/tollgate.mjs';
import { chain, ADDR, FEES, RPC_URL } from '../lib/config.mjs';
import { createRedeemer } from './redeemer.mjs';
import { httpCheck } from './http-check.mjs';
import { github } from './github.mjs';
import { rubric } from './rubric.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8790);
const REDEEM_AT = BigInt(process.env.REDEEM_AT || 5000);
const MAX_BODY = 200_000;

if (!process.env.PROVIDER_KEY) {
  console.error('PROVIDER_KEY is required (source ~/.config/foreman/keys.env)');
  process.exit(1);
}
const pk = process.env.PROVIDER_KEY;
const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);

const publicClient = createPublicClient({ chain, transport: rpc(RPC_URL) });
const walletClient = createWalletClient({ chain, transport: rpc(RPC_URL), account });
const gate = new Gate({ publicClient, contract: ADDR.TOLLGATE, provider: account.address, chainId: chain.id, token: ADDR.USDC });
const redeemer = createRedeemer({
  gate, publicClient, walletClient, redeemAt: REDEEM_AT, fees: FEES,
  logFile: process.env.REDEMPTIONS_LOG || path.join(root, 'log', 'redemptions.jsonl'),
});

const TOOLS = [httpCheck, github, rubric];
const paymentTerms = (price) => ({
  scheme: 'tollgate', chainId: chain.id, contract: ADDR.TOLLGATE, provider: account.address, token: ADDR.USDC, price, header: HEADER,
});

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': `${HEADER}, content-type`,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-expose-headers': 'content-type',
  });
  res.end(status === 204 ? undefined : JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error(`body too large (max ${MAX_BODY} bytes)`), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('body must be valid JSON'), { status: 400 });
  }
}

// Voucher checks run one at a time: Gate reads the previous total, awaits signature recovery, then
// stores the new one, so two concurrent calls with the same voucher could both pass.
let paywallQueue = Promise.resolve();
function paywall(header, price) {
  const p = paywallQueue.then(() => gate.check(header, price)).catch((e) => ({ ok: false, status: 500, error: `payment check failed: ${e.shortMessage || e.message}` }));
  paywallQueue = p.then(() => {});
  return p;
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  // A tunnel or reverse proxy on this machine would also look local; its forwarding headers give it away.
  && !req.headers['x-forwarded-for'] && !req.headers.forwarded && !req.headers['cf-connecting-ip'];

async function handleTool(tool, req, res, url) {
  if (req.method !== tool.method) return send(res, 405, { error: `use ${tool.method} ${tool.path}` });
  // Validate before taking payment: a malformed request must not cost the caller anything.
  const input = tool.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req);
  const invalid = tool.validate(input);
  if (invalid) return send(res, 400, { error: invalid });

  const paid = await paywall(req.headers[HEADER], tool.price);
  if (!paid.ok) return send(res, paid.status, { error: paid.error, payment: paymentTerms(tool.price) });

  const receipt = { channelId: paid.voucher.channelId, cumulative: paid.voucher.cumulative, price: tool.price };
  const result = await tool.run(input).catch((e) => ({ ok: false, error: `tool failed: ${e.message}` }));
  console.log(`${tool.name} paid ${tool.price} (cumulative ${receipt.cumulative}) -> ${result.ok === false ? `not ok: ${result.error ?? `status ${result.status}`}` : 'ok'}`);
  send(res, 200, { ...result, receipt });
  redeemer.run().catch(() => {}); // only redeems once REDEEM_AT is owed
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/tools' && req.method === 'GET') {
      return send(res, 200, {
        provider: account.address,
        contract: ADDR.TOLLGATE,
        chainId: chain.id,
        token: ADDR.USDC,
        header: HEADER,
        tools: TOOLS.map(({ name, method, path: p, price, description, params }) => ({ name, method, path: p, price, description, params })),
      });
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true, provider: account.address, owed: redeemer.owed() });
    if (url.pathname === '/admin/redeem') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
      if (!isLocal(req)) return send(res, 403, { error: 'admin endpoints are only available from 127.0.0.1' });
      return send(res, 200, await redeemer.run({ force: true, checkClosing: true }));
    }
    const tool = TOOLS.find((t) => t.path === url.pathname);
    if (tool) return await handleTool(tool, req, res, url);
    send(res, 404, { error: 'not found', hint: 'GET /tools lists the catalog' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

// Closing channels get redeemed within 30s, even when below REDEEM_AT.
setInterval(() => redeemer.run({ checkClosing: true }).catch(() => {}), 30_000).unref();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: redeeming outstanding vouchers before exit`);
  server.close();
  const timer = setTimeout(() => process.exit(1), 60_000);
  try {
    const { redeemed } = await redeemer.run({ force: true });
    console.log(`shutdown: ${redeemed.length} redemption(s)`);
  } catch (e) {
    console.error('shutdown redeem failed', e.message);
  }
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => {
  console.log(`foreman tool server on http://localhost:${PORT}  provider ${account.address}  tollgate ${ADDR.TOLLGATE}  chain ${chain.id}`);
  for (const t of TOOLS) console.log(`  ${t.method.padEnd(4)} ${t.path.padEnd(20)} ${t.price} units`);
  console.log(`  redeem when ${REDEEM_AT} units are owed, on POST /admin/redeem, and on shutdown`);
});
