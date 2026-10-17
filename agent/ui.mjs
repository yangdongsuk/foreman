// Terminal presentation for the Foreman CLI. These runs are filmed, so everything here is about
// readable, aligned, calm output: ANSI color only on a TTY (or FORCE_COLOR), spinner only on a TTY.
import { fmtUSDC } from '../lib/config.mjs';

const useColor = () => (process.env.NO_COLOR ? false : Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout.isTTY));
const paint = (code) => (s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'),
  blue: paint('34'), magenta: paint('35'), cyan: paint('36'), gray: paint('90'),
  bgGreen: paint('1;30;42'), bgRed: paint('1;97;41'), bgYellow: paint('1;30;43'),
};

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleLength = (s) => String(s).replace(ANSI, '').length;
export const pad = (s, n, right = false) => {
  const gap = Math.max(0, n - visibleLength(s));
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
};
export const WIDTH = Math.min(process.stdout.columns || 100, 100);

export const out = (...a) => console.log(...a);
export const blank = () => console.log('');
export const rule = (ch = '─') => out(c.gray(ch.repeat(WIDTH)));

export function header(title, sub = '') {
  blank();
  out(`${c.bold(c.cyan(' FOREMAN '))} ${c.gray('|')} ${c.bold(title)}${sub ? c.gray(`  ${sub}`) : ''}`);
  rule();
}

export const section = (title) => { blank(); out(c.bold(title)); };
export const kv = (k, v, w = 14) => out(`  ${c.gray(pad(k, w))}${v}`);
export const ok = (m) => out(`  ${c.green('✓')} ${m}`);
export const warn = (m) => out(`  ${c.yellow('!')} ${m}`);
export const fail = (m) => out(`  ${c.red('✗')} ${m}`);

/** Word-wrap `text` to the terminal width with a hanging indent. */
export function wrap(text, indent = 4, width = WIDTH) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && indent + visibleLength(line) + 1 + visibleLength(w) > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l) => ' '.repeat(indent) + l).join('\n');
}

export const usdc = (units) => `${fmtUSDC(units)} USDC`;
export const short = (h, n = 10) => (h && h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-6)}` : h);
export const link = (u) => c.blue(u);

/** Rows of cells -> aligned columns. cols: [{ title, right? }] */
export function table(cols, rows) {
  const widths = cols.map((col, i) => Math.max(visibleLength(col.title), ...rows.map((r) => visibleLength(r[i]))));
  out('  ' + cols.map((col, i) => c.gray(pad(col.title, widths[i], col.right))).join('  '));
  for (const r of rows) out('  ' + r.map((cell, i) => pad(cell, widths[i], cols[i].right)).join('  '));
}

export function badge(verdict) {
  const label = { approve: ' APPROVE ', request_revision: ' REQUEST REVISION ', escalate: ' ESCALATE ' }[verdict] ?? ` ${verdict} `;
  return { approve: c.bgGreen, request_revision: c.bgYellow, escalate: c.bgRed }[verdict]?.(label) ?? label;
}
export const statusColor = (s) => ({ Funded: c.gray, Submitted: c.yellow, Released: c.green, Refunded: c.blue, Split: c.magenta }[s] ?? ((x) => x))(s);

/** Single-line spinner for the slow model calls. Returns a stop function; a no-op off a TTY. */
export function spinner(text) {
  if (!process.stdout.isTTY) { out(`  ${c.gray('…')} ${text}`); return () => {}; }
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let i = 0;
  const draw = () => process.stdout.write(`\r  ${c.cyan(frames[i++ % frames.length])} ${c.gray(text)}\x1b[K`);
  draw();
  const t = setInterval(draw, 90);
  return () => { clearInterval(t); process.stdout.write('\r\x1b[K'); };
}

/**
 * Turns the review loop's events into the on-camera transcript. Stateful (spinner, running spend).
 * Pass the returned function as `emit` to reviewMilestone.
 */
export function reviewRenderer() {
  let stop = () => {};
  return (e) => {
    stop();
    stop = () => {};
    switch (e.type) {
      case 'context': {
        const { milestone: m, plan, policy, job, windowLeft } = e;
        header(`review  job #${e.jobId} · milestone ${e.index + 1}/${plan.plan.milestones.length}`, m.plan.name);
        kv('amount', `${c.bold(usdc(m.amount))}  ${c.gray(`(auto-approve cap ${usdc(policy.autoApproveCap)}, left today ${usdc(policy.remainingToday)})`)}`);
        kv('plan hash', `${short(job.termsHash)} ${c.green('✓ plan file matches the on-chain terms')}`);
        kv('revisions', `${m.revisions} of 3 used   ${c.gray(`review window: ${windowText(windowLeft)} left`)}`);
        kv('submission', c.cyan(clipLine(e.note || '(no note)', WIDTH - 18)));
        section('Acceptance criteria');
        m.plan.acceptanceCriteria.forEach((cr, i) => out(wrap(`${i + 1}. ${cr}`, 4)));
        break;
      }
      case 'tools':
        section('Tools (pay-per-call, Tollgate vouchers from the session key)');
        table([{ title: 'tool' }, { title: 'price', right: true }], e.catalog.map((t) => [c.bold(t.name), usdc(t.price)]));
        kv('review budget', usdc(e.budget), 16);
        break;
      case 'tools_unavailable':
        section('Tools');
        warn(`unavailable: ${e.error}`);
        break;
      case 'thinking':
        if (e.step === 1) section('Review loop');
        stop = spinner(`step ${e.step}: thinking`);
        break;
      case 'thought':
        out(`  ${c.magenta('◆')} ${c.dim(`step ${e.step}`)}  ${clipLine(e.thought, WIDTH - 14)}`);
        break;
      case 'tool_call':
        out(`    ${c.cyan('→')} ${c.bold(e.name)} ${c.gray(clipLine(JSON.stringify(e.args), WIDTH - 40))}  ${c.gray(`pay ${usdc(e.price)}`)}`);
        stop = spinner(`calling ${e.name}`);
        break;
      case 'tool_result':
        if (e.ok) out(`    ${c.green('✓')} ${clipLine(e.digest, WIDTH - 36)}  ${c.gray(`${e.ms} ms · spent ${usdc(e.spent)}`)}`);
        else out(`    ${c.red('✗')} ${clipLine(e.digest, WIDTH - 12)}`);
        break;
      case 'guardrail':
        out(`  ${c.yellow('⚑ guardrail')} ${e.text}`);
        break;
      case 'decision': {
        const r = e.record;
        section('Decision');
        out(`  ${badge(r.verdict)}  ${c.bold(usdc(r.amountUnits))}`);
        out(wrap(r.rationale, 4));
        blank();
        for (const cr of r.criteria) {
          out(`  ${cr.met ? c.green('✓') : c.red('✗')} ${clipLine(cr.criterion, WIDTH - 6)}`);
          if (cr.evidence) out(c.gray(wrap(cr.evidence, 6)));
        }
        if (r.feedbackToFreelancer) { blank(); kv('feedback', ''); out(c.yellow(wrap(r.feedbackToFreelancer, 4))); }
        blank();
        kv('tool spend', usdc(r.toolSpendUnits));
        kv('reason hash', `${c.bold(e.reasonHash)}`);
        break;
      }
      case 'tx':
        stop = () => {};
        kv('on chain', `${c.green('✓')} ${e.verdict} sent by the agent key`);
        kv('tx', link(e.url));
        break;
      case 'abort':
        warn(`aborted, no transaction sent: ${e.reason}`);
        break;
      default:
    }
  };
}

const windowText = (s) => (s >= 7200 ? `${Math.round(s / 3600)} h` : `${Math.max(0, Math.floor(s / 60))} min`);

export const clipLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
};
