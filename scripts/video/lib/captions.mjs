// Burned-in captions: TTS cues -> short chunks (max 2 lines) -> transparent PNG strips -> one overlay stream.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cuesFromText, weight } from './tts.mjs';
import { renderTemplate } from './template.mjs';
import { escapeHtml, ensureDir, fileUrl, secs } from './util.mjs';

export const STRIP_H = 240; // overlay strip height; placed at the bottom of the frame
export const LINE_CHARS = 52;
export const MAX_CHARS = 96; // two balanced lines

const SHORT = /^(a|an|the|of|to|in|on|at|for|and|or|but|with|by|as|is|are|it|its|that|this)$/i;
const CLAUSE = /^(and|but|so|which|that|because|then|while|where|when|with|without|so that|before|after)$/i;

/** Best space to break `text` at, close to the middle, preferring clause punctuation and conjunctions. */
function bestBreak(text, target = text.length / 2) {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] !== ' ') continue;
    const left = text.slice(0, i);
    const right = text.slice(i + 1);
    const lastWord = left.split(' ').pop().replace(/[^\w']/g, '');
    const nextWord = right.split(' ')[0].replace(/[^\w']/g, '');
    let score = Math.abs(i - target);
    if (/[,;:—–)]$/.test(left)) score -= 14;
    else if (CLAUSE.test(nextWord)) score -= 6;
    if (SHORT.test(lastWord)) score += 12; // don't strand "the" / "to" at the end of a line
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Split text into pieces of at most `max` characters at natural breaks. */
export function splitText(text, max = MAX_CHARS) {
  text = text.trim();
  if (text.length <= max) return [text];
  const i = bestBreak(text);
  if (i < 0) return [text];
  return [...splitText(text.slice(0, i), max), ...splitText(text.slice(i + 1), max)];
}

/** One or two balanced lines. */
export function layoutLines(text, lineChars = LINE_CHARS) {
  text = text.trim();
  if (text.length <= lineChars) return [text];
  const i = bestBreak(text);
  return i < 0 ? [text] : [text.slice(0, i), text.slice(i + 1)];
}

/**
 * Cues ({start,end,text}, seconds relative to the narration start) -> caption chunks
 * ({start,end,lines}). Long sentences are split and the time is shared by text weight.
 */
export function buildChunks(cues, { maxChars = MAX_CHARS, lineChars = LINE_CHARS, hold = 0.12, narrationEnd } = {}) {
  const chunks = [];
  for (const cue of cues) {
    const pieces = splitText(cue.text, maxChars);
    const total = pieces.reduce((n, p) => n + weight(p), 0) || 1;
    let t = cue.start;
    for (const p of pieces) {
      const end = t + ((cue.end - cue.start) * weight(p)) / total;
      chunks.push({ start: t, end, lines: layoutLines(p, lineChars) });
      t = end;
    }
  }
  // keep a caption on screen until the next one starts (or briefly after the voice ends)
  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1];
    chunks[i].end = next ? Math.max(chunks[i].end, Math.min(next.start, chunks[i].end + 0.35)) : chunks[i].end + hold;
    if (narrationEnd !== undefined) chunks[i].end = Math.min(chunks[i].end, narrationEnd);
  }
  return chunks.filter((c) => c.end - c.start > 0.05);
}

/** Cues for a segment: the TTS cues, or an explicit `caption` text spread over the narration. */
export function segmentChunks(seg) {
  if (seg.captionOff || !seg.audio) return [];
  const cues = seg.captionText ? cuesFromText(seg.captionText, 0.05, Math.max(0.2, seg.audio.duration - 0.05)) : seg.audio.cues;
  return buildChunks(cues, { narrationEnd: seg.audio.duration });
}

// ---------------------------------------------------------------- rendering
export async function openCaptionPage(browser, { toolkitDir, workDir }) {
  const page = await browser.newPage({ width: 1920, height: STRIP_H, transparent: true });
  const src = readFileSync(join(toolkitDir, 'lib/html/caption.html'), 'utf8');
  const { html } = renderTemplate(src, { base: fileUrl(join(toolkitDir, 'lib/html') + '/') }, { name: 'caption.html' });
  const file = join(workDir, 'caption-page.html');
  writeFileSync(file, html);
  await page.goto(fileUrl(file));
  return page;
}

export async function renderCaptionPng(page, lines, outFile) {
  const html = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  await page.evaluate(`window.__setCaption(${JSON.stringify(html)})`);
  writeFileSync(outFile, await page.screenshot());
}

export async function renderBlankPng(page, outFile) {
  await page.evaluate('window.__setCaption("")');
  writeFileSync(outFile, await page.screenshot());
}

/** Global SRT (also handy to upload to YouTube as a caption track). */
export function toSrt(entries) {
  const ts = (x) => {
    const ms = Math.round(x * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return entries.map((e, i) => `${i + 1}\n${ts(e.start)} --> ${ts(e.end)}\n${e.lines.join('\n')}\n`).join('\n');
}

/** All caption entries on the global timeline (seconds), never overlapping. */
export function captionEntries(segments) {
  const entries = [];
  for (const seg of segments) {
    if (!seg.audio) continue;
    const offset = secs(seg.narrationF);
    for (const ch of segmentChunks(seg)) entries.push({ start: offset + ch.start, end: Math.min(offset + ch.end, secs(seg.B + seg.D)), lines: ch.lines });
  }
  entries.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < entries.length; i++) entries[i].end = Math.min(entries[i].end, entries[i + 1].start);
  return entries.filter((e) => e.end - e.start > 0.05);
}

/**
 * Render one transparent PNG per distinct caption and write the ffmpeg concat list that plays them on the global
 * timeline (blank frames in the gaps). Returns the list file path.
 */
export async function buildCaptionTrack(entries, { browser, toolkitDir, workDir, total }) {
  const page = await openCaptionPage(browser, { toolkitDir, workDir });
  try {
    const dir = ensureDir(join(workDir, 'captions'));
    const blank = join(dir, 'blank.png');
    await renderBlankPng(page, blank);
    const q = (p) => `file '${p.replace(/'/g, "'\\''")}'`;
    const lines = [];
    const seen = new Map();
    let t = 0;
    for (const [i, e] of entries.entries()) {
      if (e.start > t + 0.001) lines.push(q(blank), `duration ${(e.start - t).toFixed(6)}`);
      const key = e.lines.join('\n');
      if (!seen.has(key)) {
        const png = join(dir, `cap-${String(i).padStart(3, '0')}.png`);
        await renderCaptionPng(page, e.lines, png);
        seen.set(key, png);
      }
      lines.push(q(seen.get(key)), `duration ${(e.end - e.start).toFixed(6)}`);
      t = e.end;
    }
    lines.push(q(blank), `duration ${Math.max(0.1, total - t + 0.5).toFixed(6)}`, q(blank)); // pad past the end; -t trims
    const listFile = join(workDir, 'captions.txt');
    writeFileSync(listFile, lines.join('\n') + '\n');
    return listFile;
  } finally {
    await page.close();
  }
}
