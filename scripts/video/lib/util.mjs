// Shared helpers: constants, logging, process running, ffprobe, hashing.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const frames = (sec) => Math.round(sec * FPS);
export const secs = (f) => f / FPS;

// ---------------------------------------------------------------- logging
const tty = process.stderr.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };

export const log = {
  verbose: false,
  step: (msg) => console.error(c.bold(c.cyan('>> ')) + c.bold(msg)),
  info: (msg) => console.error('   ' + msg),
  debug: (msg) => log.verbose && console.error(c.dim('   ' + msg)),
  ok: (msg) => console.error(c.green('   ok ') + msg),
  warn: (msg) => console.error(c.yellow('   warning: ') + msg),
};

export class UserError extends Error {}
export const fail = (msg) => {
  throw new UserError(msg);
};

// ---------------------------------------------------------------- misc
export const sha1 = (...parts) => {
  const h = createHash('sha1');
  for (const p of parts) h.update(typeof p === 'string' || Buffer.isBuffer(p) ? p : (JSON.stringify(p) ?? 'undefined')).update('\0');
  return h.digest('hex');
};

export const ensureDir = (d) => (mkdirSync(d, { recursive: true }), d);
export const fileUrl = (p) => pathToFileURL(p).href;
export const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function readJson(file, what = 'file') {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    fail(`cannot read ${what} ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${what} ${file} is not valid JSON: ${e.message}`);
  }
}

export const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

export const hexColor = (s, fallback = '#0A0F1F') => (/^#[0-9a-f]{6}$/i.test(s ?? '') ? s : fallback);

// every child we start; killed if we exit for any reason (Ctrl-C, SIGTERM, crash)
const children = new Set();
process.on('exit', () => {
  for (const ch of children) {
    try {
      ch.kill('SIGKILL');
    } catch {}
  }
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));

/** Run a subprocess; resolves with {stdout, stderr}; rejects with a readable error (stderr tail included). */
export function run(cmd, args, { capture = true, onStdout, input, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.on('close', () => children.delete(child));
    let stdout = '';
    let stderr = '';
    const timer = timeout
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${cmd} timed out after ${timeout / 1000}s`));
        }, timeout)
      : null;
    child.stdout.on('data', (d) => {
      if (onStdout) onStdout(d.toString());
      if (capture) stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot run "${cmd}": ${e.message} (is it installed and on PATH?)`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.trim().split('\n').slice(-25).join('\n');
      const cmdline = [cmd, ...args].map((a) => (/[\s'"()[\]|;]/.test(a) ? JSON.stringify(a) : a)).join(' ');
      reject(new Error(`${cmd} exited with code ${code}\n${tail}\n--- command ---\n${cmdline.slice(0, 3000)}`));
    });
    if (input) child.stdin.end(input);
  });
}

/** ffmpeg wrapper. `totalFrames` enables a one-line progress readout while encoding. */
export async function ffmpeg(args, { totalFrames, label } = {}) {
  const base = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  const progress = totalFrames && tty ? ['-progress', 'pipe:1', '-nostats'] : [];
  if (log.verbose) console.error(c.dim('   $ ffmpeg ' + args.map((a) => (/[\s'"()[\]|;]/.test(a) ? JSON.stringify(a) : a)).join(' ')));
  let last = 0;
  const onStdout = progress.length
    ? (chunk) => {
        const m = [...chunk.matchAll(/^frame=(\d+)/gm)].pop();
        if (!m) return;
        const f = Number(m[1]);
        if (f - last < 15) return;
        last = f;
        process.stderr.write(`\r   ${label ?? 'encoding'} ${Math.min(100, Math.round((100 * f) / totalFrames))}%   `);
      }
    : undefined;
  try {
    return await run('ffmpeg', [...base, ...progress, ...args], { onStdout, capture: !progress.length });
  } finally {
    if (progress.length) process.stderr.write('\r' + ' '.repeat(40) + '\r');
  }
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  return JSON.parse(stdout);
}

export async function mediaDuration(file) {
  const info = await probe(file);
  const d = Number(info.format?.duration);
  if (!Number.isFinite(d) || d <= 0) fail(`cannot determine duration of ${file}`);
  return d;
}

/** Run async jobs with bounded concurrency; results keep input order; first error rejects. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}
