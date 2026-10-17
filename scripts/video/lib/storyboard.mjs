// Storyboard loading, validation and timeline planning.
//
// STORYBOARD SCHEMA (JSON; a bare array is treated as { "segments": [...] })
//
//   {
//     "title": "Foreman demo",              // metadata tag in the mp4
//     "voice": "en-US-AndrewNeural", "rate": "+5%", "pitch": "+0Hz", "volume": "+0%",
//     "tts": "edge",                        // "edge" (Microsoft neural) | "say" (macOS offline)
//     "lead": 0.2, "tail": 0.2,             // silence before / after each narration (0.4 s padding in total)
//     "crossfade": 0.3,                     // seconds between segments, 0 = hard cuts
//     "transition": "fade",                 // any ffmpeg xfade name: fade, fadeblack, dissolve, ...
//     "captions": true,                     // burn in captions from the narration
//     "music": "assets/bed.mp3", "musicDb": 20,   // optional quiet bed, dB below the narration
//     "background": "#0A0F1F",              // letterbox color for images
//     "segments": [ ... ]
//   }
//
// Every segment: { "type", "narration"?, "duration"?, "lead"?, "tail"?, "caption"? }
//   narration  text to speak. Segment length = narration audio + lead + tail (0.4 s) unless "duration" is set.
//   duration   explicit seconds (required when there is no narration). Longer than the audio = a silent hold.
//   caption    text to show instead of the narration, or false to hide captions for this segment.
//
//   "slide"       html (template path), vars {..}. Values may be strings, lists, or {"$file": "x.svg"} (inlined text),
//                 {"$url": "img.png"} (absolute file URL). See slides/*.html for each template's vars.
//   "terminal"    log (ANSI log path), title?, command? (typed first), reveal? "lines"|"all", rows? (30),
//                 fontSize?, start?, hold?, prompt?, endPrompt?, maxFrames?
//   "screenshot"  url (https://..., file:// or a local path), viewport? [w,h], delay? (s, default 1.5), timeout? (s),
//                 waitFor? (CSS selector), scrollTo? (selector | px), hide? [selectors], css?, crop? {x,y,width,height},
//                 scale?, idle? (wait for network idle, default true), cache? (reuse an earlier capture)
//   "image"       path (png/jpg/webp/svg), fit? "blur" (default) | "contain" | "cover", crop? {x,y,width,height}
//
//   slide / screenshot / image also take Ken Burns motion:
//     kenburns  true | "in" | "out" | "left" | "right" | "up" | "down" | { from: {x,y,zoom}, to: {x,y,zoom} }
//     zoom      end zoom for the presets (default 1.12; 1.15 for pans)    focus  [x, y] in 0..1 the zoom drifts toward
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FPS, fail, fileUrl, frames, hexColor, log, readJson } from './util.mjs';

export const TOOLKIT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  voice: 'en-US-AndrewNeural',
  rate: '+5%',
  pitch: '+0Hz',
  volume: '+0%',
  tts: 'edge',
  lead: 0.2,
  tail: 0.2,
  crossfade: 0.3,
  transition: 'fade',
  captions: true,
  music: null,
  musicDb: 20,
  background: '#0A0F1F',
  title: '',
};

const COMMON = ['type', 'id', 'narration', 'duration', 'lead', 'tail', 'caption'];
const MOTION = ['kenburns', 'zoom', 'focus'];
const FIELDS = {
  slide: ['html', 'vars', ...MOTION],
  terminal: ['log', 'title', 'command', 'prompt', 'reveal', 'rows', 'fontSize', 'start', 'hold', 'endPrompt', 'maxFrames'],
  screenshot: ['url', 'viewport', 'scale', 'delay', 'timeout', 'waitFor', 'scrollTo', 'hide', 'css', 'crop', 'fit', 'idle', 'cache', ...MOTION],
  image: ['path', 'fit', 'crop', ...MOTION],
};

const SETTING_KEYS = [...Object.keys(DEFAULTS), 'segments', 'maxDuration'];

function resolveFile(p, dirs, what) {
  if (typeof p !== 'string' || !p) fail(`${what}: expected a file path`);
  const tried = isAbsolute(p) ? [p] : [...new Set(dirs.map((d) => resolve(d, p)))];
  const hit = tried.find((t) => existsSync(t));
  if (!hit) fail(`${what}: file not found: ${p}\n   looked in:\n${tried.map((t) => '     ' + t).join('\n')}`);
  return hit;
}

function num(v, name, label, { min = -Infinity, max = Infinity } = {}) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${label}: "${name}" must be a number${max < Infinity ? ` between ${min} and ${max}` : min > -Infinity ? ` >= ${min}` : ''}, got ${JSON.stringify(v)}`);
  return v;
}

function resolveVars(vars, dirs, label) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '$file') {
        const file = resolveFile(v.$file, dirs, `${label}: $file`);
        return readFileSync(file, 'utf8').replace(/<\?xml[^>]*\?>\s*/g, '').replace(/<!DOCTYPE[^>]*>\s*/gi, '').trim();
      }
      if (keys.length === 1 && keys[0] === '$url') return fileUrl(resolveFile(v.$url, dirs, `${label}: $url`));
      return Object.fromEntries(keys.map((k) => [k, walk(v[k])]));
    }
    return v;
  };
  return walk(vars ?? {});
}

function checkMotion(seg, label) {
  const k = seg.kenburns;
  if (k === undefined || k === false) return { motion: null };
  const presets = ['in', 'out', 'left', 'right', 'up', 'down'];
  if (k !== true && !presets.includes(k) && !(typeof k === 'object' && k && k.from && k.to)) {
    fail(`${label}: "kenburns" must be true, one of ${presets.join('/')}, or {"from":{x,y,zoom},"to":{x,y,zoom}}`);
  }
  const focus = seg.focus ?? [0.5, 0.5];
  if (!Array.isArray(focus) || focus.length !== 2 || focus.some((n) => typeof n !== 'number' || n < 0 || n > 1)) fail(`${label}: "focus" must be [x, y] with values 0..1`);
  return { motion: k === true ? 'in' : k, zoom: num(seg.zoom, 'zoom', label, { min: 1, max: 4 }), focus };
}

export function loadStoryboard(file, overrides = {}) {
  const abs = resolve(file);
  const raw = readJson(abs, 'storyboard');
  const body = Array.isArray(raw) ? { segments: raw } : raw;
  if (!body || typeof body !== 'object' || !Array.isArray(body.segments) || body.segments.length === 0) {
    fail(`storyboard ${file}: needs a non-empty "segments" list`);
  }
  for (const k of Object.keys(body)) if (!SETTING_KEYS.includes(k)) log.warn(`storyboard: unknown setting "${k}" (ignored). Known: ${SETTING_KEYS.join(', ')}`);

  const dir = dirname(abs);
  const dirs = [dir, TOOLKIT_DIR, process.cwd()];
  const settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'segments')) };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) settings[k] = v;
  settings.background = hexColor(settings.background);
  settings.crossfade = num(settings.crossfade, 'crossfade', 'storyboard', { min: 0, max: 3 }) ?? 0.3;
  settings.lead = num(settings.lead, 'lead', 'storyboard', { min: 0, max: 5 }) ?? 0.2;
  settings.tail = num(settings.tail, 'tail', 'storyboard', { min: 0, max: 5 }) ?? 0.2;
  if (settings.music) settings.music = resolveFile(settings.music, dirs, 'storyboard "music"');
  if (!['edge', 'say'].includes(settings.tts)) fail(`storyboard: "tts" must be "edge" or "say", got ${JSON.stringify(settings.tts)}`);

  const segments = body.segments.map((s, i) => {
    const n = i + 1;
    if (!s || typeof s !== 'object') fail(`segment ${n}: must be an object`);
    const type = s.type;
    if (!FIELDS[type]) fail(`segment ${n}: "type" must be one of ${Object.keys(FIELDS).join(', ')}, got ${JSON.stringify(type)}`);
    const label = `segment ${n} (${type})`;
    for (const k of Object.keys(s)) if (!COMMON.includes(k) && !FIELDS[type].includes(k)) log.warn(`${label}: unknown field "${k}" (ignored)`);

    const narration = typeof s.narration === 'string' && s.narration.trim() ? s.narration.replace(/\s+/g, ' ').trim() : null;
    if (s.narration !== undefined && s.narration !== null && typeof s.narration !== 'string') fail(`${label}: "narration" must be a string`);
    const duration = num(s.duration, 'duration', label, { min: 0.5, max: 600 });
    if (!narration && duration === undefined) fail(`${label}: needs "narration" or an explicit "duration"`);

    const seg = {
      index: i,
      n,
      type,
      label,
      narration,
      duration,
      lead: num(s.lead, 'lead', label, { min: 0, max: 5 }) ?? settings.lead,
      tail: num(s.tail, 'tail', label, { min: 0, max: 5 }) ?? settings.tail,
      captionOff: s.caption === false,
      captionText: typeof s.caption === 'string' && s.caption.trim() ? s.caption.trim() : null,
    };

    if (type === 'slide') {
      seg.htmlPath = resolveFile(s.html, dirs, `${label}: "html"`);
      seg.vars = resolveVars(s.vars, dirs, label);
      Object.assign(seg, checkMotion(s, label));
    } else if (type === 'terminal') {
      seg.logPath = resolveFile(s.log, dirs, `${label}: "log"`);
      if (s.reveal !== undefined && !['lines', 'all'].includes(s.reveal)) fail(`${label}: "reveal" must be "lines" or "all"`);
      Object.assign(seg, {
        title: s.title,
        command: typeof s.command === 'string' ? s.command : undefined,
        prompt: typeof s.prompt === 'string' ? s.prompt : undefined,
        reveal: s.reveal ?? 'lines',
        rows: num(s.rows, 'rows', label, { min: 4, max: 80 }),
        fontSize: num(s.fontSize, 'fontSize', label, { min: 10, max: 48 }),
        start: num(s.start, 'start', label, { min: 0, max: 30 }),
        hold: num(s.hold, 'hold', label, { min: 0, max: 30 }),
        endPrompt: s.endPrompt,
        maxFrames: num(s.maxFrames, 'maxFrames', label, { min: 5, max: 400 }),
      });
    } else if (type === 'screenshot') {
      if (typeof s.url !== 'string' || !s.url) fail(`${label}: "url" is required`);
      const isUrl = /^(https?|file):\/\//i.test(s.url);
      seg.url = isUrl ? s.url : fileUrl(resolveFile(s.url, dirs, `${label}: "url"`));
      const vp = s.viewport ?? [1920, 1080];
      if (!Array.isArray(vp) || vp.length !== 2 || vp.some((x) => !Number.isFinite(x) || x < 200)) fail(`${label}: "viewport" must be [width, height]`);
      Object.assign(seg, {
        viewport: vp,
        scale: num(s.scale, 'scale', label, { min: 1, max: 3 }),
        delay: num(s.delay, 'delay', label, { min: 0, max: 120 }) ?? 1.5,
        timeout: num(s.timeout, 'timeout', label, { min: 1, max: 300 }) ?? 30,
        waitFor: s.waitFor,
        scrollTo: s.scrollTo,
        hide: s.hide === undefined ? [] : [].concat(s.hide),
        css: s.css,
        crop: checkCrop(s.crop, label),
        fit: checkFit(s.fit, label),
        idle: s.idle !== false,
        cache: s.cache === true,
      });
      Object.assign(seg, checkMotion(s, label));
    } else if (type === 'image') {
      seg.imagePath = resolveFile(s.path, dirs, `${label}: "path"`);
      Object.assign(seg, { crop: checkCrop(s.crop, label), fit: checkFit(s.fit, label, 'blur') }, checkMotion(s, label));
    }
    return seg;
  });
  return { settings, segments, dir, file: abs };
}

function checkCrop(c, label) {
  if (c === undefined || c === null) return null;
  if (typeof c !== 'object' || ['x', 'y', 'width', 'height'].some((k) => !Number.isFinite(c[k])) || c.width <= 0 || c.height <= 0) {
    fail(`${label}: "crop" must be {"x":0,"y":0,"width":1280,"height":720} (source pixels)`);
  }
  return { x: c.x, y: c.y, width: c.width, height: c.height };
}

function checkFit(f, label, fallback = 'contain') {
  if (f === undefined) return fallback;
  if (!['contain', 'cover', 'blur'].includes(f)) fail(`${label}: "fit" must be "contain" (letterbox), "cover" (crop to fill) or "blur" (contain over a blurred copy of itself)`);
  return f;
}

/**
 * Frame-exact timeline. Narration for segment i starts `lead` after its nominal start; crossfades are centred on the
 * nominal boundaries, so clips carry a few extra head/tail frames and the audio never needs to know about them.
 */
export function planTimeline(segments, settings) {
  const X = Math.round(settings.crossfade * FPS); // crossfade length in frames
  const minD = Math.max(15, X + 2);
  let b = 0;
  const n = segments.length;
  for (const [i, seg] of segments.entries()) {
    const leadF = frames(seg.lead);
    const tailF = frames(seg.tail);
    const audioF = seg.audio ? Math.ceil(seg.audio.duration * FPS) : 0;
    const needed = leadF + audioF + tailF;
    let D = needed;
    if (seg.duration !== undefined) {
      D = frames(seg.duration);
      if (seg.audio && D < leadF + audioF + 2) {
        log.warn(`${seg.label}: duration ${seg.duration}s is shorter than the narration (${seg.audio.duration.toFixed(1)}s + ${seg.lead}s lead); extended to ${(needed / FPS).toFixed(1)}s`);
        D = needed;
      }
    }
    D = Math.max(D, minD);
    seg.leadF = leadF;
    seg.audioF = audioF;
    seg.D = D;
    seg.hasPrev = i > 0;
    seg.hasNext = i < n - 1;
    seg.headF = i > 0 ? Math.floor(X / 2) : 0;
    seg.tailF = i < n - 1 ? X - Math.floor(X / 2) : 0;
    seg.L = seg.headF + D + seg.tailF; // frames in the clip
    seg.B = b; // nominal start (frames)
    seg.narrationF = b + leadF;
    b += D;
  }
  return { totalFrames: b, crossfadeFrames: X };
}
