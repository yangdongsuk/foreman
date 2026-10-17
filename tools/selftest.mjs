// End-to-end test of the tool server against a local node (see test-fixtures/local-selftest.sh).
//
// Env: RPC_URL, CHAIN_ID, TOLLGATE, USDC, PROVIDER_KEY, SESSION_KEY and either CHANNEL_ID (an open channel to
// the provider with SESSION as signer) or OWNER_KEY (the test opens one; USDC must have `mint(address,uint256)`).
// Optional: SELFTEST_LLM=1 uses the real LLM judge for /tools/rubric; GITHUB_LIVE=1 also hits the real GitHub API.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http as rpc, parseEventLogs, parseAbi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Meter, signVoucher, encodeVoucher, HEADER, TOLLGATE_ABI } from '../vendor/tollgate.mjs';
import { chain, ADDR } from '../lib/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SELFTEST_PORT || 18790);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
}
const j = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

// ---------------------------------------------------------------- local fixtures
const PAGE = `<!doctype html><html><head><title>Acme &amp; Co - Home</title>
<meta name="description" content="We build robust widgets.">
<style>body{color:red}</style><script>var secret = "SCRIPT-CONTENT";</script></head>
<body><h1>Welcome to <em>Acme</em></h1><p>Fast, reliable widgets.</p>
<a href="/a">A</a> <a href='/b'>B</a> <a name="x">not a link</a></body></html>`;

const web = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/' }); return res.end(); }
  if (req.url === '/data.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"hello":"world"}'); }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});

// Tiny stand-in for the GitHub REST API so the test is deterministic and offline.
const fakeGithub = http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = req.url.split('?')[0];
  const sha = 'a'.repeat(40);
  const wantsDiff = (req.headers.accept || '').includes('diff');
  if (p === '/repos/acme/widgets/pulls/7') {
    if (wantsDiff) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`diff --git a/x b/x\n${'+line\n'.repeat(3000)}`); }
    return json({ title: 'Add widget API', body: 'B'.repeat(3000), state: 'closed', merged: true, draft: false, user: { login: 'dev' },
      base: { ref: 'main' }, head: { ref: 'feat', sha }, additions: 120, deletions: 4, changed_files: 3, commits: 2 });
  }
  if (p === '/repos/acme/widgets/pulls/7/files') return json([{ filename: 'src/api.js', status: 'added', additions: 100, deletions: 0 }, { filename: 'README.md', status: 'modified', additions: 20, deletions: 4 }]);
  if (p.endsWith(`/commits/${sha}/status`)) return json({ state: 'success', total_count: 1 });
  if (p.endsWith(`/commits/${sha}/check-runs`)) return json({ total_count: 2, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'failure' }] });
  if (p === '/repos/acme/widgets') return json({ full_name: 'acme/widgets', description: 'Widgets', stargazers_count: 42, default_branch: 'main', language: 'JavaScript', pushed_at: '2026-10-01T00:00:00Z', archived: false });
  if (p === '/repos/acme/widgets/commits') return json([{ sha, commit: { message: 'Initial commit\n\nbody', author: { date: '2026-10-01T00:00:00Z' } } }]);
  if (p === '/repos/acme/widgets/readme') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`# Widgets\n${'text '.repeat(2000)}`); }
  if (p === `/repos/acme/widgets/commits/${sha.slice(0, 10)}` || p === `/repos/acme/widgets/commits/${sha}`) {
    return json({ sha, commit: { message: 'Fix bug', author: { name: 'Dev', date: '2026-10-02T00:00:00Z' } }, stats: { additions: 5, deletions: 1, total: 6 }, files: [{ filename: 'a.js', status: 'modified', additions: 5, deletions: 1 }] });
  }
  json({ message: 'Not Found' }, 404);
});
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ---------------------------------------------------------------- chain setup
const publicClient = createPublicClient({ chain, transport: rpc(process.env.RPC_URL) });
const provider = privateKeyToAccount(process.env.PROVIDER_KEY);
const session = privateKeyToAccount(process.env.SESSION_KEY);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)', 'function approve(address,uint256) returns (bool)']);
const DEPOSIT = 1_000_000n; // 1 USDC

async function openChannel() {
  if (process.env.CHANNEL_ID) return process.env.CHANNEL_ID;
  const owner = privateKeyToAccount(process.env.OWNER_KEY);
  const wallet = createWalletClient({ chain, transport: rpc(process.env.RPC_URL), account: owner });
  const send = async (args) => publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain, ...args }) });
  await send({ address: ADDR.USDC, abi: ERC20, functionName: 'mint', args: [owner.address, DEPOSIT] }).catch(() => {});
  await send({ address: ADDR.USDC, abi: ERC20, functionName: 'approve', args: [ADDR.TOLLGATE, DEPOSIT] });
  const abi = parseAbi(['function open(address provider, address signer, address token, uint128 amount, uint64 grace) returns (bytes32)']);
  const receipt = await send({ address: ADDR.TOLLGATE, abi, functionName: 'open', args: [provider.address, session.address, ADDR.USDC, DEPOSIT, 600] });
  return parseEventLogs({ abi: TOLLGATE_ABI, logs: receipt.logs, eventName: 'ChannelOpened' })[0].args.channelId;
}
const chainChannel = () => publicClient.readContract({ address: ADDR.TOLLGATE, abi: TOLLGATE_ABI, functionName: 'channels', args: [channelId] });
const redeemedOnChain = async () => (await chainChannel())[5];
const providerBalance = () => publicClient.readContract({ address: ADDR.USDC, abi: ERC20, functionName: 'balanceOf', args: [provider.address] });

// ---------------------------------------------------------------- http helpers
const call = async (method, p, { voucher, body, headers = {} } = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(voucher ? { [HEADER]: voucher } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
};

let channelId;
let meter;
let accepted = 0n; // highest cumulative the server acknowledged with a 200
const paid = async (method, p, price, opts = {}) => {
  const r = await call(method, p, { ...opts, voucher: await meter.pay(price) });
  if (r.status === 200) accepted = BigInt(r.data.receipt.cumulative);
  return r;
};

// ---------------------------------------------------------------- run
const webPort = await listen(web);
const ghPort = await listen(fakeGithub);
channelId = await openChannel();
meter = new Meter({ account: session, contract: ADDR.TOLLGATE, channelId, chainId: chain.id });
console.log(`channel ${channelId}\nprovider ${provider.address}  session ${session.address}\n`);

const balance0 = await providerBalance();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-tools-'));
const redemptionLog = path.join(tmp, 'redemptions.jsonl');
const server = spawn(process.execPath, [path.join(root, 'tools', 'server.mjs')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, PORT: String(PORT), REDEEM_AT: '5000', ALLOW_PRIVATE_URLS: '1', REDEMPTIONS_LOG: redemptionLog,
    GITHUB_API: `http://127.0.0.1:${ghPort}`,
    // An invalid key makes agent/llm.mjs fail fast, which exercises the heuristic fallback deterministically.
    ...(process.env.SELFTEST_LLM === '1' ? {} : { ANTHROPIC_API_KEY: 'sk-invalid-selftest' }),
  },
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
const exited = new Promise((r) => server.on('exit', (code) => r(code)));

try {
  for (let i = 0; i < 50; i++) { if (await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)) break; await sleep(100); }

  // --- catalog and CORS
  let r = await call('GET', '/tools');
  check('GET /tools is free and lists provider, contract, chain, token', r.status === 200 && r.data.provider === provider.address
    && r.data.contract === ADDR.TOLLGATE && r.data.chainId === chain.id && r.data.token === ADDR.USDC, j(r.data));
  const byName = Object.fromEntries((r.data.tools || []).map((t) => [t.name, t]));
  check('catalog has http-check/github/rubric with prices 1000/2000/5000',
    byName['http-check']?.price == 1000 && byName.github?.price == 2000 && byName.rubric?.price == 5000
    && byName['http-check'].method === 'GET' && byName.rubric.method === 'POST' && byName.rubric.path === '/tools/rubric');
  check('every tool has description and params', (r.data.tools || []).every((t) => t.description && t.params));
  check('CORS allow-origin on responses', r.headers.get('access-control-allow-origin') === '*');
  const pre = await call('OPTIONS', '/tools/rubric');
  check('OPTIONS preflight 204 allows x-tollgate-voucher',
    pre.status === 204 && /x-tollgate-voucher/.test(pre.headers.get('access-control-allow-headers')) && /content-type/.test(pre.headers.get('access-control-allow-headers')));

  // --- payment gate
  const target = `http://127.0.0.1:${webPort}/`;
  const q = (u) => `/tools/http-check?url=${encodeURIComponent(u)}`;
  r = await call('GET', q(target));
  check('402 without voucher, with payment terms', r.status === 402 && r.data.payment?.scheme === 'tollgate'
    && r.data.payment.contract === ADDR.TOLLGATE && r.data.payment.provider === provider.address
    && r.data.payment.token === ADDR.USDC && r.data.payment.chainId === chain.id
    && r.data.payment.price == 1000 && r.data.payment.header === HEADER, j(r.data));
  r = await call('GET', q(target), { voucher: 'garbage' });
  check('402 for a malformed voucher', r.status === 402 && /malformed/.test(r.data.error), j(r.data));

  const v1 = await meter.pay(1000);
  r = await call('GET', q(target), { voucher: v1 });
  accepted = r.status === 200 ? BigInt(r.data.receipt.cumulative) : accepted;
  check('200 with a valid voucher', r.status === 200 && r.data.ok === true, j(r.data));
  check('receipt has channelId, cumulative, price', r.data.receipt?.channelId === channelId && r.data.receipt.cumulative === '1000' && r.data.receipt.price === '1000', j(r.data.receipt));
  check('http-check fields (status, title, h1, meta, links, text)',
    r.data.status === 200 && r.data.title === 'Acme & Co - Home' && r.data.h1 === 'Welcome to Acme'
    && r.data.metaDescription === 'We build robust widgets.' && r.data.linkCount === 2
    && r.data.textSample.includes('Fast, reliable widgets.') && !r.data.textSample.includes('SCRIPT-CONTENT') && !r.data.textSample.includes('color:red')
    && r.data.finalUrl === target && r.data.contentType.startsWith('text/html') && r.data.bytes > 100 && typeof r.data.ms === 'number', j(r.data));

  r = await call('GET', q(target), { voucher: v1 });
  check('replaying a voucher is rejected (402)', r.status === 402 && /at least/.test(r.data.error), j(r.data));

  const stranger = privateKeyToAccount(generatePrivateKey());
  const forged = encodeVoucher(await signVoucher({ account: stranger, contract: ADDR.TOLLGATE, chainId: chain.id, channelId, cumulative: meter.cumulative + 1000n }));
  r = await call('GET', q(target), { voucher: forged });
  check('voucher signed by the wrong key is rejected', r.status === 402 && r.data.error === 'bad signature', j(r.data));

  const under = encodeVoucher(await signVoucher({ account: session, contract: ADDR.TOLLGATE, chainId: chain.id, channelId, cumulative: meter.cumulative + 500n }));
  r = await call('GET', q(target), { voucher: under });
  check('underpaying voucher is rejected', r.status === 402 && /at least/.test(r.data.error), j(r.data));

  const over = encodeVoucher(await signVoucher({ account: session, contract: ADDR.TOLLGATE, chainId: chain.id, channelId, cumulative: DEPOSIT + 1n }));
  r = await call('GET', q(target), { voucher: over });
  check('voucher above the channel balance is rejected', r.status === 402 && /exhausted/.test(r.data.error), j(r.data));

  const ghost = encodeVoucher(await signVoucher({ account: session, contract: ADDR.TOLLGATE, chainId: chain.id, channelId: `0x${'ab'.repeat(32)}`, cumulative: 1000n }));
  r = await call('GET', q(target), { voucher: ghost });
  check('voucher for an unknown channel is rejected', r.status === 402 && r.data.error === 'unknown channel', j(r.data));

  // a bad request must not consume the voucher
  const v2 = await meter.pay(1000);
  r = await call('GET', '/tools/http-check?url=not-a-url', { voucher: v2 });
  check('400 for invalid params', r.status === 400, j(r.data));
  r = await call('GET', q(target), { voucher: v2 });
  check('a 400 does not spend the voucher (same voucher still works)', r.status === 200 && r.data.receipt.cumulative === String(meter.cumulative), j(r.data));
  accepted = BigInt(r.data.receipt.cumulative);

  // concurrent use of one voucher: exactly one winner
  const v3 = await meter.pay(1000);
  const race = await Promise.all([call('GET', q(target), { voucher: v3 }), call('GET', q(target), { voucher: v3 })]);
  check('same voucher used twice concurrently: one 200, one 402', race.filter((x) => x.status === 200).length === 1 && race.filter((x) => x.status === 402).length === 1, race.map((x) => x.status).join(','));
  accepted = BigInt(meter.cumulative);

  check('wrong method gives 405', (await call('POST', q(target))).status === 405);
  check('unknown path gives 404', (await call('GET', '/nope')).status === 404);

  // --- http-check variants
  r = await paid('GET', q(`http://127.0.0.1:${webPort}/redirect`), 1000);
  check('http-check follows redirects (finalUrl)', r.status === 200 && r.data.finalUrl === target && r.data.status === 200, j(r.data));
  r = await paid('GET', q(`http://127.0.0.1:${webPort}/missing`), 1000);
  check('http-check reports a 404 as data (ok:false, status 404)', r.status === 200 && r.data.ok === false && r.data.status === 404, j(r.data));
  r = await paid('GET', q(`http://127.0.0.1:${webPort}/data.json`), 1000);
  check('http-check on JSON returns text sample', r.status === 200 && r.data.textSample.includes('"hello"'), j(r.data));
  r = await paid('GET', q('http://127.0.0.1:1/'), 1000);
  check('http-check on a dead host reports ok:false with error', r.status === 200 && r.data.ok === false && /fetch failed/.test(r.data.error), j(r.data));

  // SSRF guard (the spawned server runs with ALLOW_PRIVATE_URLS=1, so test the guard directly)
  const { ssrfError } = await import('./util.mjs');
  const saved = process.env.ALLOW_PRIVATE_URLS;
  delete process.env.ALLOW_PRIVATE_URLS;
  const blocked = await Promise.all(['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/', 'http://10.1.2.3/', 'http://[::1]/', 'http://192.168.0.1/', 'http://[::ffff:127.0.0.1]/'].map((u) => ssrfError(new URL(u))));
  check('SSRF guard blocks loopback/private/link-local targets', blocked.every(Boolean), j(blocked));
  check('SSRF guard allows a public IP literal', (await ssrfError(new URL('http://93.184.216.34/'))) === null);
  process.env.ALLOW_PRIVATE_URLS = saved;

  // --- github (fake API)
  const gh = (u) => `/tools/github?url=${encodeURIComponent(u)}`;
  r = await paid('GET', gh('https://github.com/acme/widgets/pull/7'), 2000);
  check('github PR: title, merged, size, files, diff excerpt, CI', r.status === 200 && r.data.ok && r.data.kind === 'pull_request'
    && r.data.title === 'Add widget API' && r.data.merged === true && r.data.additions === 120 && r.data.changed_files === 3 && r.data.commits === 2
    && r.data.files.length === 2 && r.data.files[0].filename === 'src/api.js'
    && r.data.body.length === 2000 && r.data.diffExcerpt.length === 6000 && r.data.diffExcerpt.startsWith('diff --git')
    && r.data.ci.state === 'failure' && r.data.ci.totalChecks === 3, j(r.data).slice(0, 600));
  r = await paid('GET', gh('https://github.com/acme/widgets'), 2000);
  check('github repo: description, stars, branch, latest commit, README excerpt', r.status === 200 && r.data.kind === 'repo' && r.data.stars === 42
    && r.data.default_branch === 'main' && r.data.latestCommit?.message === 'Initial commit\n\nbody' && r.data.readmeExcerpt.length === 3000, j(r.data).slice(0, 600));
  r = await paid('GET', gh(`https://github.com/acme/widgets/commit/${'a'.repeat(40)}`), 2000);
  check('github commit: message, stats, files', r.status === 200 && r.data.kind === 'commit' && r.data.message === 'Fix bug' && r.data.stats.total === 6 && r.data.files.length === 1, j(r.data).slice(0, 400));
  r = await paid('GET', gh('https://github.com/acme/missing'), 2000);
  check('github upstream 404 is reported as data (ok:false, status 404)', r.status === 200 && r.data.ok === false && r.data.status === 404, j(r.data));
  r = await call('GET', gh('https://example.com/acme/widgets'), { voucher: await meter.pay(2000) });
  check('github rejects non-github URLs with 400 (not charged)', r.status === 400, j(r.data));
  if (process.env.GITHUB_LIVE === '1') {
    const { github } = await import('./github.mjs');
    const live = await github.run({ url: process.env.GITHUB_LIVE_URL || 'https://github.com/foundry-rs/forge-std' });
    check(`github live API (${live.kind || 'error'})`, live.ok === true, j(live).slice(0, 300));
  }

  // --- rubric
  const rubricBody = {
    criteria: ['Landing page shows a pricing table', 'Page title mentions Acme', 'Site is deployed over HTTPS'],
    deliverable: 'Deployed the Acme landing page; see the live site.',
    evidence: 'http-check: status 200, title "Acme & Co - Home", h1 "Welcome to Acme", text "Fast, reliable widgets." No pricing section seen. Served over http.',
  };
  r = await paid('POST', '/tools/rubric', 5000, { body: rubricBody });
  const rubricOk = r.status === 200 && ['llm', 'heuristic'].includes(r.data.method) && Array.isArray(r.data.verdicts)
    && r.data.verdicts.length === 3 && r.data.verdicts.every((v, i) => v.criterion === rubricBody.criteria[i] && typeof v.met === 'boolean' && typeof v.confidence === 'number' && typeof v.rationale === 'string')
    && typeof r.data.summary === 'string' && r.data.receipt.price === '5000';
  check(`rubric returns a verdict per criterion (method: ${r.data.method})`, rubricOk, j(r.data).slice(0, 500));
  if (r.data.method === 'heuristic') {
    check('heuristic result is labeled and never overconfident', /heuristic/i.test(r.data.note) && r.data.verdicts.every((v) => v.confidence <= 0.4));
    check('heuristic: weakly matched criterion is not met, strongly matched one is', r.data.verdicts[0].met === false && r.data.verdicts[1].met === true, j(r.data.verdicts));
  } else {
    check('llm judge: pricing criterion not met', r.data.verdicts[0].met === false, j(r.data.verdicts));
  }
  r = await call('POST', '/tools/rubric', { voucher: await meter.pay(5000), body: { criteria: [], deliverable: 'x' } });
  check('rubric 400 on empty criteria', r.status === 400, j(r.data));
  r = await call('POST', '/tools/rubric', { voucher: await meter.pay(5000), body: { criteria: ['a'], deliverable: '' } });
  check('rubric 400 on empty deliverable', r.status === 400, j(r.data));
  r = await call('POST', '/tools/rubric', { body: rubricBody });
  check('rubric 402 without voucher', r.status === 402 && r.data.payment.price == 5000, j(r.data));

  // --- redemption on chain
  const cumulativeNow = accepted;
  check('some spend has accumulated beyond REDEEM_AT', cumulativeNow >= 5000n, String(cumulativeNow));
  let redeemed = 0n;
  for (let i = 0; i < 100 && redeemed === 0n; i++) { redeemed = await redeemedOnChain(); if (!redeemed) await sleep(100); }
  check('auto-redeem fired once REDEEM_AT was owed (on-chain redeemed > 0)', redeemed > 0n, String(redeemed));
  const afterAuto = await redeemedOnChain();
  check('provider received the USDC', (await providerBalance()) - balance0 === afterAuto, `${await providerBalance()} vs ${balance0} + ${afterAuto}`);

  // Settle everything, then owe a little less than REDEEM_AT: nothing should be redeemed automatically.
  r = await call('POST', '/admin/redeem');
  check('/admin/redeem requires POST', (await call('GET', '/admin/redeem')).status === 405);
  check('/admin/redeem refuses requests that came through a proxy (403)', (await call('POST', '/admin/redeem', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status === 403);
  check('after /admin/redeem the chain is settled up to the last accepted voucher', r.status === 200 && (await redeemedOnChain()) === accepted, `${j(r.data)} chain ${await redeemedOnChain()} vs ${accepted}`);
  meter.cumulative = accepted; // skipped (rejected) vouchers above also count as owed, so resync
  const beforeSmall = await redeemedOnChain();
  await paid('GET', q(target), 1000);
  await sleep(500);
  check('below REDEEM_AT nothing is redeemed automatically', (await redeemedOnChain()) === beforeSmall, `${beforeSmall} -> ${await redeemedOnChain()}`);
  r = await call('POST', '/admin/redeem');
  check('POST /admin/redeem redeems the best voucher', r.status === 200 && r.data.redeemed.length === 1 && r.data.redeemed[0].cumulative === String(accepted)
    && /^0x[0-9a-f]{64}$/.test(r.data.redeemed[0].tx) && r.data.redeemed[0].redeemedUnits === '1000', j(r.data));
  check('on-chain redeemed equals the last accepted cumulative', (await redeemedOnChain()) === accepted, `${await redeemedOnChain()} vs ${accepted}`);
  check('provider balance increased by exactly the redeemed total', (await providerBalance()) - balance0 === accepted, `${await providerBalance()} vs ${balance0} + ${accepted}`);
  r = await call('POST', '/admin/redeem');
  check('a second /admin/redeem has nothing to do', r.status === 200 && r.data.redeemed.length === 0, j(r.data));

  const lines = fs.readFileSync(redemptionLog, 'utf8').trim().split('\n').map(JSON.parse);
  check('log/redemptions.jsonl has { ts, channelId, cumulative, tx } per redemption', lines.length >= 2
    && lines.every((l) => l.ts && l.channelId === channelId && /^\d+$/.test(l.cumulative) && /^0x[0-9a-f]{64}$/.test(l.tx))
    && lines.at(-1).cumulative === String(accepted), j(lines));
  check('server printed the explorer URL', /\/tx\/0x[0-9a-f]{64}/.test(serverOut));

  // --- redeem on SIGTERM
  await paid('GET', q(target), 1000);
  await paid('GET', q(target), 1000);
  check('voucher is pending before shutdown', (await redeemedOnChain()) < accepted);
  server.kill('SIGTERM');
  const code = await Promise.race([exited, sleep(30_000).then(() => 'timeout')]);
  check('SIGTERM redeems outstanding vouchers and exits 0', code === 0 && (await redeemedOnChain()) === accepted, `exit ${code}, chain ${await redeemedOnChain()} vs ${accepted}`);
} catch (e) {
  failed++;
  console.error('FAIL  selftest crashed:', e);
} finally {
  if (server.exitCode === null) server.kill('SIGKILL');
  web.close();
  fakeGithub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) console.log(`\nserver output:\n${serverOut}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
