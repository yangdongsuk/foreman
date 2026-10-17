// Headless Chrome driven over the DevTools protocol (Node's built-in WebSocket, no dependencies).
// One Chrome instance renders everything (slides, terminal frames, captions, web screenshots):
// ~70 ms per screenshot instead of a ~1 s process launch per frame.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, log } from './util.mjs';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome(explicit) {
  const wanted = explicit || process.env.CHROME_BIN;
  if (wanted) {
    if (!existsSync(wanted)) fail(`Chrome not found at ${wanted} (from --chrome / CHROME_BIN)`);
    return wanted;
  }
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) fail('Google Chrome not found. Install it or set CHROME_BIN=/path/to/chrome (or pass --chrome).');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Browser {
  static async launch({ chrome } = {}) {
    const bin = findChrome(chrome);
    const userDataDir = mkdtempSync(join(tmpdir(), 'foreman-video-chrome-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0', // pick a free port; announced in DevToolsActivePort
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--mute-audio',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb', // brand colors must survive: no display-profile shifts
      '--allow-file-access-from-files', // local dashboards fetching ./data/*.json, module scripts from file://
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ];
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    let exited = null;
    child.on('exit', (code, sig) => (exited = { code, sig }));
    // never leave an orphaned Chrome behind, whatever happens to us
    const killSync = () => {
      try {
        child.kill('SIGKILL');
      } catch {}
    };
    process.on('exit', killSync);

    const portFile = join(userDataDir, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(portFile) && !exited; i++) await sleep(100);
    if (!existsSync(portFile)) {
      killSync();
      fail(`Chrome did not start (${exited ? `exited ${exited.code ?? exited.sig}` : 'timeout'}).\n${stderr.trim().split('\n').slice(-5).join('\n')}`);
    }
    const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('cannot connect to Chrome DevTools websocket')), { once: true });
    });
    return new Browser({ child, ws, userDataDir, killSync });
  }

  constructor({ child, ws, userDataDir, killSync }) {
    Object.assign(this, { child, ws, userDataDir, killSync });
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const l of this.listeners) l(msg);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Chrome connection closed unexpectedly'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId, timeout = 90_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome did not answer ${method} within ${timeout / 1000}s`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async newPage(opts = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init(opts);
    return page;
  }

  async close() {
    try {
      await this.send('Browser.close', {}, undefined, 5000);
    } catch {}
    for (let i = 0; i < 30 && this.child.exitCode === null && this.child.signalCode === null; i++) await sleep(100);
    this.killSync();
    try {
      this.ws.close();
    } catch {}
    try {
      rmSync(this.userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.inflight = new Set();
    this.urls = new Map();
    this.lastNetworkActivity = Date.now();
    this.problems = []; // failed requests / page errors, surfaced as warnings
    this.crashed = false;
    this.off = browser.on((m) => this.#onEvent(m));
  }

  #onEvent(m) {
    if (m.sessionId !== this.sessionId) return;
    const p = m.params ?? {};
    switch (m.method) {
      case 'Network.requestWillBeSent':
        if (!p.request.url.startsWith('data:')) this.inflight.add(p.requestId);
        this.urls.set(p.requestId, p.request.url.slice(0, 120));
        this.lastNetworkActivity = Date.now();
        break;
      case 'Network.loadingFinished':
        this.inflight.delete(p.requestId);
        this.lastNetworkActivity = Date.now();
        break;
      case 'Network.loadingFailed':
        this.inflight.delete(p.requestId);
        this.lastNetworkActivity = Date.now();
        if (!p.canceled) this.problems.push(`request failed: ${p.errorText} (${this.urls.get(p.requestId) ?? 'unknown url'})`);
        break;
      case 'Network.responseReceived':
        if (p.response.status >= 400) this.problems.push(`HTTP ${p.response.status}: ${p.response.url}`);
        break;
      case 'Runtime.exceptionThrown':
        this.problems.push(`page error: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`);
        break;
      case 'Inspector.targetCrashed':
        this.crashed = true;
        break;
    }
  }

  cdp(method, params = {}, timeout) {
    if (this.crashed) throw new Error('the Chrome tab crashed');
    return this.browser.send(method, params, this.sessionId, timeout);
  }

  async init({ width = 1920, height = 1080, scale = 1, transparent = false } = {}) {
    await Promise.all([this.cdp('Page.enable'), this.cdp('Runtime.enable'), this.cdp('Network.enable')]);
    await this.setViewport({ width, height, scale });
    if (transparent) {
      await this.cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
  }

  setViewport({ width, height, scale = 1 }) {
    return this.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  }

  once(method, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method}`));
      }, timeout);
      const off = this.browser.on((m) => {
        if (m.sessionId === this.sessionId && m.method === method) {
          clearTimeout(timer);
          off();
          resolve(m.params);
        }
      });
    });
  }

  /** Navigate and wait for load (+ optional network idle). Never hangs: every wait is bounded. */
  async goto(url, { timeout = 30_000, idle = false, idleMs = 800 } = {}) {
    this.problems.length = 0;
    this.inflight.clear();
    const loaded = this.once('Page.loadEventFired', timeout);
    loaded.catch(() => {}); // avoid an unhandled rejection if navigate() throws first
    const nav = await this.cdp('Page.navigate', { url }, timeout);
    if (nav.errorText) fail(`cannot open ${url}: ${nav.errorText}`);
    try {
      await loaded;
    } catch {
      log.warn(`${url} did not finish loading within ${timeout / 1000}s; screenshotting what is there`);
    }
    if (idle) await this.waitNetworkIdle({ timeout, idleMs });
    await this.settle();
  }

  async waitNetworkIdle({ timeout = 30_000, idleMs = 800 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.inflight.size === 0 && Date.now() - this.lastNetworkActivity >= idleMs) return true;
      await sleep(100);
    }
    log.warn(`network still busy after ${timeout / 1000}s (${this.inflight.size} requests in flight); continuing`);
    return false;
  }

  /** Fonts and images decoded, two animation frames rendered. */
  settle() {
    return this.evaluate(`(async () => {
      try { await document.fonts.ready; } catch (e) {}
      await Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 5000); })));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return true;
    })()`);
  }

  async waitForSelector(selector, timeout = 20_000) {
    const ok = await this.evaluate(
      `(async () => { const end = Date.now() + ${timeout}; while (Date.now() < end) { const el = document.querySelector(${JSON.stringify(selector)}); if (el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return true; await new Promise(r => setTimeout(r, 100)); } return false; })()`,
      timeout + 5000,
    );
    if (!ok) log.warn(`selector "${selector}" did not appear within ${timeout / 1000}s`);
    return ok;
  }

  async evaluate(expression, timeout) {
    const r = await this.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page script failed: ${d.exception?.description ?? d.text}`);
    }
    return r.result.value;
  }

  /** PNG bytes. `clip` is in CSS pixels; `scale` re-renders the clip at higher density (crisp crops). */
  async screenshot({ clip } = {}) {
    const params = { format: 'png', fromSurface: true };
    if (clip) Object.assign(params, { clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale ?? 1 }, captureBeyondViewport: true });
    const { data } = await this.cdp('Page.captureScreenshot', params);
    return Buffer.from(data, 'base64');
  }

  async close() {
    this.off();
    try {
      await this.browser.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5000);
    } catch {}
  }
}
