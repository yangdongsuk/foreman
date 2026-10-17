// Terminal segment: ANSI log -> macOS-style window, revealed line by line, scrolling once the window is full.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEME, parseAnsi, rowToHtml, rowWidth, wrapRow } from './ansi.mjs';
import { renderTemplate } from './template.mjs';
import { ensureDir, escapeHtml, fail, fileUrl, sha1 } from './util.mjs';

const CHAR_W = 0.602; // Menlo advance width in em
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function terminalLayout({ rows = 30, fontSize, captions = true, contentCols = 100 }) {
  const top = 30;
  const bottom = captions ? 172 : 34; // captions on: keep their lane free so they never cover the newest lines
  const titleH = 44;
  const padV = 14;
  const padH = 28;
  const avail = 1080 - top - bottom;
  const bodyAvail = avail - titleH - 2 * padV;
  let lh;
  let fs;
  if (fontSize) {
    fs = fontSize;
    lh = Math.round(fs * 1.32);
    rows = Math.max(4, Math.floor(bodyAvail / lh));
  } else {
    lh = Math.floor(bodyAvail / rows);
    fs = clamp(Math.floor(lh * 0.78), 12, 34);
  }
  const cw = fs * CHAR_W;
  const winW = clamp(Math.ceil(contentCols * cw + 2 * padH + 90), 1240, 1808);
  const cols = Math.floor((winW - 2 * padH) / cw) - 1;
  const bodyH = rows * lh;
  return { top, titleH, padV, padH, rows, lh, fs, cw, winW, winX: Math.round((1920 - winW) / 2), winH: titleH + bodyH + 2 * padV, bodyH, cols };
}

// prompt (may carry ANSI colors) + a space + the typed text; built from two parses so the space survives trimming
const promptHtml = (prompt, text) => `${rowToHtml(parseAnsi(prompt)[0] ?? [])} ${rowToHtml(parseAnsi(text)[0] ?? [])}`;

/**
 * Render the frames of a terminal segment.
 * Returns [{ png, t }]: `t` = seconds from the segment's nominal start at which the frame appears.
 */
export async function renderTerminal(page, seg, { workDir, toolkitDir, nominalSec, captions, label }) {
  let text;
  try {
    text = readFileSync(seg.logPath, 'utf8');
  } catch (e) {
    fail(`${label}: cannot read log ${seg.logPath}: ${e.message}`);
  }
  const parsed = parseAnsi(text);
  if (!parsed.length) fail(`${label}: log ${seg.logPath} is empty (after stripping control codes)`);

  // size the window to typical lines (90th percentile), not the longest one: long prose just wraps
  const widths = parsed.map(rowWidth).sort((a, b) => a - b);
  const contentCols = clamp(widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.9))], 60, 130);
  const L = terminalLayout({ rows: seg.rows, fontSize: seg.fontSize, captions, contentCols });
  const prompt = seg.prompt ?? '\x1b[1;38;5;141m❯\x1b[0m';

  // logical lines -> wrapped visual rows (as HTML), computed once
  const lines = parsed.map((row) => wrapRow(row, L.cols).map((r) => rowToHtml(r)));
  const isBlank = (i) => lines[i].every((h) => h === '');

  // page
  const src = readFileSync(join(toolkitDir, 'lib/html/terminal.html'), 'utf8');
  const { html } = renderTemplate(
    src,
    {
      base: fileUrl(join(toolkitDir, 'lib/html') + '/'),
      winX: L.winX, winY: L.top, winW: L.winW, winH: L.winH, titleH: L.titleH, bodyH: L.bodyH, padV: L.padV, padH: L.padH,
      fs: L.fs, lh: L.lh, bg: THEME.bg, fg: THEME.fg,
      titleHtml: escapeHtml(seg.title ?? seg.logPath.split('/').pop()),
    },
    { name: 'terminal.html' },
  );
  const dir = ensureDir(join(workDir, label.replace(/\W+/g, '-')));
  const pageFile = join(dir, 'page.html');
  writeFileSync(pageFile, html);
  await page.goto(fileUrl(pageFile));

  // ---- states: { t, html }
  const cursor = '<span class="cur"></span>';
  const row = (h) => `<div class="row">${h}</div>`;
  const render = (dataRows, cursorRowHtml) => {
    const visible = dataRows.slice(-(L.rows - 1));
    return visible.map(row).join('') + row(cursorRowHtml);
  };
  const command = seg.command;
  const prefix = command ? [promptHtml(prompt, command)] : [];
  const states = [];
  const D = nominalSec;
  const start = seg.start ?? 0.4;
  const hold = seg.hold ?? clamp(0.12 * D, 1.0, 2.5);

  if (seg.reveal === 'all') {
    const all = [...prefix, ...lines.flat()];
    states.push({ t: 0, html: render(all, seg.endPrompt === false ? cursor : promptHtml(prompt, '') + cursor) });
  } else {
    states.push({ t: 0, html: render([], command ? promptHtml(prompt, '') + cursor : cursor) });
    let t = start;
    if (command) {
      const typeDur = clamp(0.045 * command.length, 0.5, 1.4);
      const steps = Math.max(2, Math.ceil(command.length / 2));
      for (let k = 1; k <= steps; k++) {
        const n = Math.round((command.length * k) / steps);
        states.push({ t: start + (typeDur * (k - 1)) / steps, html: render([], promptHtml(prompt, command.slice(0, n)) + cursor) });
      }
      t = start + typeDur + 0.3;
      states.push({ t: t - 0.3, html: render(prefix, cursor) }); // command fully typed, "enter" pressed
    }
    // group blank lines with the preceding line; one group = one reveal step
    const groups = [];
    for (let i = 0; i < lines.length; i++) {
      if (isBlank(i) && groups.length) groups[groups.length - 1].end = i + 1;
      else groups.push({ end: i + 1 });
    }
    const maxFrames = seg.maxFrames ?? 90;
    const chunk = Math.ceil(groups.length / maxFrames);
    const steps = [];
    for (let g = chunk - 1; g < groups.length + chunk - 1; g += chunk) steps.push(groups[Math.min(g, groups.length - 1)].end);
    if (steps[steps.length - 1] !== lines.length) steps.push(lines.length);
    const revealEnd = Math.max(t + 0.5, D - hold);
    steps.forEach((upTo, k) => {
      const at = t + ((revealEnd - t) * k) / steps.length;
      states.push({ t: at, html: render([...prefix, ...lines.slice(0, upTo).flat()], cursor) });
    });
    // output finished: the shell prompt returns and the screen holds until the segment ends
    if (seg.endPrompt !== false) states.push({ t: revealEnd, html: render([...prefix, ...lines.flat()], promptHtml(prompt, '') + cursor) });
  }

  // ---- screenshots (identical consecutive states are rendered once)
  const frames = [];
  let prevHtml = null;
  let k = 0;
  for (const st of states) {
    if (st.html === prevHtml) continue;
    prevHtml = st.html;
    await page.evaluate(`window.__setBody(${JSON.stringify(st.html)})`);
    const png = join(dir, `f${String(k++).padStart(4, '0')}-${sha1(st.html).slice(0, 6)}.png`);
    writeFileSync(png, await page.screenshot());
    frames.push({ png, t: st.t });
  }
  return frames;
}
