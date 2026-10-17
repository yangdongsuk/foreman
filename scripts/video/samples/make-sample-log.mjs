// Regenerates samples/review.ansi.log: a fake but realistic `foreman review` session with colors.
// Real logs: FORCE_COLOR=1 node agent/foreman.mjs review --job 3 2>&1 | tee review.log   (or: script -q review.log <command>)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const E = '\x1b[';
const bold = (s) => `${E}1m${s}${E}22m`;
const dim = (s) => `${E}2m${s}${E}22m`;
const green = (s) => `${E}32m${s}${E}39m`;
const red = (s) => `${E}31m${s}${E}39m`;
const yellow = (s) => `${E}33m${s}${E}39m`;
const cyan = (s) => `${E}36m${s}${E}39m`;
const magenta = (s) => `${E}35m${s}${E}39m`;
const purple = (s) => `${E}38;5;141m${s}${E}39m`; // 256-color
const usdc = (s) => `${E}38;2;39;117;202m${s}${E}39m`; // truecolor
const link = (s) => `${E}4;38;5;75m${s}${E}24;39m`;
const hash = (s) => dim(s);

const L = [];
const out = (s = '') => L.push(s);

out(`${E}?25l${purple(bold('▌'))} ${bold('FOREMAN')}  ${dim('review · job #3 · milestone 1 of 3')} ${bold('"Landing page"')}`);
out(dim('─'.repeat(96)));
out(`  ${dim('plan       ')} ${hash('0x9c1e…b7a2')}  ${green('✓')} matches on-chain termsHash`);
out(`  ${dim('policy     ')} auto-approve ≤ ${usdc('50.00 USDC')} · today 0.00 / 200.00 USDC · ${green('running')}`);
out(`  ${dim('submitted  ')} ${link('https://github.com/acme-co/landing-page/pull/14')}`);
out(`  ${dim('amount     ')} ${bold(usdc('40.00 USDC'))} → freelancer ${hash('0x7Ab3…19Fe')}`);
out();
out(`  ${bold('step 1/3')}  ${magenta('think')}  Need proof the PR is real and merged, then the live URL.`);
out(`            ${cyan('tool ')}  github        ${dim('0.002000 USDC')}  ${hash('receipt 0x41ab…c9d0')}`);
out(`            ${dim('↳ PR #14 merged · +312 −41 · 9 files · checks passing')}`);
out(`  ${bold('step 2/3')}  ${magenta('think')}  Check the deployed page against criteria 1–4.`);
out(`            ${cyan('tool ')}  http-check    ${dim('0.001000 USDC')}  ${hash('receipt 0x41ab…d1e7')}`);
out(`            ${dim('↳ 200 OK · 412 ms · title "Acme — Landing" · 6 sections · 14 links')}`);
out(`  ${bold('step 3/3')}  ${magenta('think')}  Judge the evidence against the written acceptance criteria.`);
out(`            ${cyan('tool ')}  rubric        ${dim('0.005000 USDC')}  ${hash('receipt 0x41ab…e3f8')}`);
out(`            ${dim('↳ 4/4 criteria met · confidence 0.91')}`);
out();
out(`  ${bold('criteria')}`);
const crit = (text, evidence) => out(`    ${green('✓')} ${text.padEnd(46)} ${dim(evidence)}`);
crit('Responsive layout at 375 / 768 / 1280 px', 'viewport meta + 3 breakpoints in the diff');
crit('Lighthouse performance ≥ 90', 'check-run "lighthouse" = 94');
crit('Contact form posts to /api/lead', 'diff adds the POST handler and a test');
crit('Deployed at the agreed URL', '200 OK, title matches the brief');
out();
out(`  ${dim('rationale  ')} All four acceptance criteria are met and each one is backed by independent evidence (diff, check-runs, live fetch). Spend on tools was 0.008 USDC, well inside the 0.05 USDC review budget. No revision needed.`);
out();
out(`  ${dim('guardrails ')} ${green('✓')} amount 40.00 ≤ auto-approve cap 50.00`);
out(`              ${green('✓')} daily total 40.00 ≤ 200.00  ${green('✓')} not paused  ${green('✓')} review window 71h left`);
out();
out(`  ${dim('decision   ')} ${E}1;30;42m APPROVE ${E}0m  ${dim('tool spend 0.008000 USDC')}`);
out(`  ${dim('reasonHash ')} ${hash('0x5be1…77a0')}`);
// a spinner line that is overwritten in place (carriage return + erase line), as real CLIs do
out(`  ${yellow('⠋')} waiting for confirmation…\r${E}2K  ${yellow('⠙')} waiting for confirmation…\r${E}2K  ${green('✓')} confirmed   ${dim('block 1,284,311 · gas 0.0021 USDC')}`);
out(`  ${dim('tx         ')} ${link('https://explorer.arc.io/tx/0x3f9c…a21b')}`);
out(`  ${green('✓')} ${bold('40.00 USDC released to the freelancer')} ${E}?25h`);

const file = join(dirname(fileURLToPath(import.meta.url)), 'review.ansi.log');
writeFileSync(file, L.join('\n') + '\n');
console.log(`wrote ${file} (${L.length} lines)`);
