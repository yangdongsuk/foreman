// Turns a segment into PNG(s): slides (HTML templates), images, web screenshots. Terminals live in terminal.mjs.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { renderTemplate } from './template.mjs';
import { ensureDir, escapeHtml, fail, fileUrl, log, sha1 } from './util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render scale: Ken Burns zooms need spare pixels, everything else is crisper at 1x. */
const renderScale = (seg) => seg.scale ?? (seg.motion ? 2 : 1);

export async function renderSlide(page, seg, { workDir }) {
  const src = readFileSync(seg.htmlPath, 'utf8');
  const { html, warnings } = renderTemplate(src, seg.vars, { name: basename(seg.htmlPath) });
  for (const w of warnings) log.warn(`${seg.label}: ${w}`);
  const base = `<base href="${fileUrl(dirname(seg.htmlPath) + '/')}">`;
  const withBase = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
  const file = join(workDir, `seg-${seg.n}-slide.html`);
  writeFileSync(file, withBase);
  await page.setViewport({ width: 1920, height: 1080, scale: renderScale(seg) });
  await page.goto(fileUrl(file), { idle: true, idleMs: 250, timeout: 20_000 });
  await sleep(150);
  warnProblems(page, seg);
  const png = join(workDir, `seg-${seg.n}.png`);
  writeFileSync(png, await page.screenshot());
  return { kind: 'still', png };
}

// In-page layout for image segments: crop window + contain/cover fit, computed with real image dimensions.
const IMAGE_LAYOUT_JS = `
window.__ready = (async () => {
  const P = window.__p;
  const im = document.getElementById('im');
  try { await im.decode(); } catch (e) { return 'decode-failed'; }
  const nw = im.naturalWidth || P.vw, nh = im.naturalHeight || P.vh;
  const c = P.crop || { x: 0, y: 0, width: nw, height: nh };
  const s = P.fit === 'cover' ? Math.max(P.vw / c.width, P.vh / c.height) : Math.min(P.vw / c.width, P.vh / c.height);
  if (P.fit === 'blur') document.getElementById('bg').style.display = 'block';
  const bw = Math.min(P.vw, c.width * s), bh = Math.min(P.vh, c.height * s);
  const box = document.getElementById('box');
  box.style.left = ((P.vw - bw) / 2) + 'px';
  box.style.top = ((P.vh - bh) / 2) + 'px';
  box.style.width = bw + 'px';
  box.style.height = bh + 'px';
  im.style.width = (nw * s) + 'px';
  im.style.height = (nh * s) + 'px';
  im.style.left = (((bw - c.width * s) / 2) - c.x * s) + 'px'; // cover may overflow the box: crop evenly
  im.style.top = (((bh - c.height * s) / 2) - c.y * s) + 'px';
  return 'ok';
})();`;

export async function renderImage(page, seg, { workDir, settings }) {
  const vw = 1920;
  const vh = 1080;
  const file = join(workDir, `seg-${seg.n}-image.html`);
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${vw}px;height:${vh}px;overflow:hidden;background:${settings.background}}
#box{position:absolute;overflow:hidden}#im{position:absolute;max-width:none;display:block}
#bg{display:none;position:absolute;left:-80px;top:-80px;width:${vw + 160}px;height:${vh + 160}px;object-fit:cover;filter:blur(46px) brightness(.5) saturate(1.1)}
</style></head><body><img id="bg" src="${escapeHtml(fileUrl(seg.imagePath))}"><div id="box"><img id="im" src="${escapeHtml(fileUrl(seg.imagePath))}"></div>
<script>window.__p = ${JSON.stringify({ vw, vh, crop: seg.crop, fit: seg.fit })};</script>
<script>${IMAGE_LAYOUT_JS}</script></body></html>`,
  );
  await page.setViewport({ width: vw, height: vh, scale: renderScale(seg) });
  await page.goto(fileUrl(file), { timeout: 20_000 });
  const status = await page.evaluate('window.__ready');
  if (status !== 'ok') fail(`${seg.label}: cannot decode image ${seg.imagePath}`);
  const png = join(workDir, `seg-${seg.n}.png`);
  writeFileSync(png, await page.screenshot());
  return { kind: 'still', png };
}

export async function renderScreenshot(page, seg, { workDir, cacheDir }) {
  const png = join(workDir, `seg-${seg.n}.png`);
  const key = sha1('shot-v1', seg.url, seg.viewport, renderScale(seg), seg.css, seg.hide, seg.waitFor, seg.scrollTo, seg.crop, seg.delay);
  const cached = join(ensureDir(join(cacheDir, 'screens')), `${key}.png`);
  if (seg.cache && existsSync(cached)) {
    log.info(`${seg.label}: using cached screenshot (cache: true)`);
    copyFileSync(cached, png);
    return { kind: 'still', png };
  }

  const [vw, vh] = seg.viewport;
  const scale = renderScale(seg);
  await page.setViewport({ width: vw, height: vh, scale });
  await page.goto(seg.url, { idle: seg.idle, idleMs: 800, timeout: seg.timeout * 1000 });
  const css = [seg.css ?? '', ...seg.hide.map((s) => `${s}{display:none !important}`)].join('\n').trim();
  if (css) await page.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
  if (seg.waitFor) await page.waitForSelector(seg.waitFor, seg.timeout * 1000);
  if (seg.scrollTo !== undefined) {
    const to = seg.scrollTo;
    await page.evaluate(
      typeof to === 'number'
        ? `window.scrollTo(0, ${to})`
        : `(() => { const el = document.querySelector(${JSON.stringify(String(to))}); if (el) el.scrollIntoView({ block: 'start' }); return !!el; })()`,
    );
  }
  await sleep(seg.delay * 1000); // JS-rendered pages: let timers, fetches and animations finish
  await page.settle();
  warnProblems(page, seg);

  let clip;
  if (seg.crop) {
    // crop is relative to what the viewport shows; CDP wants document coordinates and re-renders the region sharply
    const { sx, sy } = await page.evaluate('({ sx: window.scrollX, sy: window.scrollY })');
    const target = Math.min(1920 / seg.crop.width, 1080 / seg.crop.height);
    clip = { x: seg.crop.x + sx, y: seg.crop.y + sy, width: seg.crop.width, height: seg.crop.height, scale: Math.max(0.25, target / scale) };
  }
  const buf = await page.screenshot({ clip });
  writeFileSync(png, buf);
  if (buf.length < 9000) log.warn(`${seg.label}: the screenshot is nearly empty (${buf.length} bytes). Did the page load? Try a larger "delay" or a "waitFor" selector.`);
  if (seg.cache) copyFileSync(png, cached);
  return { kind: 'still', png };
}

function warnProblems(page, seg) {
  const uniq = [...new Set(page.problems)].filter((p) => !/favicon/i.test(p));
  if (!uniq.length) return;
  log.warn(`${seg.label}: the page reported ${uniq.length} problem${uniq.length > 1 ? 's' : ''}:`);
  for (const p of uniq.slice(0, 5)) log.info(`  - ${p}`);
}

