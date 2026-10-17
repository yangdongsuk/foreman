#!/usr/bin/env node
// Storyboard -> demo video (1920x1080, 30 fps, H.264 + AAC). See lib/storyboard.mjs for the storyboard schema.
//
//   node build.mjs storyboard.json out/demo.mp4 [options]      (node build.mjs --help)
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assemble } from './lib/assemble.mjs';
import { buildNarrationTrack, mixMusic, normalizeLoudness, reportLoudness } from './lib/audio.mjs';
import { openCaptionPage, renderBlankPng, renderCaptionPng, segmentChunks, toSrt } from './lib/captions.mjs';
import { Browser } from './lib/chrome.mjs';
import { encodeClip } from './lib/clips.mjs';
import { TOOLKIT_DIR, loadStoryboard, planTimeline } from './lib/storyboard.mjs';
import { renderTerminal } from './lib/terminal.mjs';
import { synthesize } from './lib/tts.mjs';
import { UserError, c, ensureDir, fail, fmtTime, log, pool, probe, run, secs } from './lib/util.mjs';
import { renderImage, renderScreenshot, renderSlide } from './lib/visuals.mjs';

const HELP = `
Usage: node build.mjs <storyboard.json> [out.mp4] [options]

Builds a narrated demo video: TTS per segment, rendered slides / terminal sessions / web screenshots / images,
crossfades, loudness-normalised audio (-16 LUFS), optional music bed, burned-in captions.

Options
  --no-captions         do not burn captions in (an .srt next to the video is still written)
  --music <file>        quiet background music (looped, faded); --music-db <n> sets how far under the voice (default 20)
  --voice <name>        TTS voice (default en-US-AndrewNeural)      --rate <+5%>   speaking rate
  --tts <edge|say>      "say" = macOS offline voices (use if Microsoft TTS is unreachable)
  --crossfade <sec>     0.3 by default, 0 = hard cuts
  --crf <n>             x264 quality, default 18 (lower = bigger)   --preset <name>   x264 preset, default medium
  --draft               fast low-quality encode, for checking timing and layout
  --plan                synthesise narration, print the timeline and total length, then stop
  --only <1,3,4>        build only these segments (1-based), e.g. to iterate on one terminal
  --max-duration <sec>  warn above this length (default 178 = 2:58)
  --jobs <n>            parallel TTS requests (default 4)
  --no-cache            re-synthesise narration and re-encode clips
  --keep-work           keep intermediate frames in cache/work/<name>
  --chrome <path>       Chrome binary (or set CHROME_BIN)
  -v, --verbose         print every ffmpeg command
  -h, --help

Capture a real terminal session with colors:  FORCE_COLOR=1 node agent/foreman.mjs review --job 3 2>&1 | tee review.log
Storyboard schema: see the header of lib/storyboard.mjs and storyboard.example.json.
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    verbose: { type: 'boolean', short: 'v' },
    captions: { type: 'boolean' },
    music: { type: 'string' },
    'music-db': { type: 'string' },
    voice: { type: 'string' },
    rate: { type: 'string' },
    tts: { type: 'string' },
    crossfade: { type: 'string' },
    crf: { type: 'string', default: '18' },
    preset: { type: 'string', default: 'medium' },
    draft: { type: 'boolean' },
    plan: { type: 'boolean' },
    only: { type: 'string' },
    'max-duration': { type: 'string', default: '178' },
    jobs: { type: 'string', default: '4' },
    cache: { type: 'boolean' },
    'keep-work': { type: 'boolean' },
    chrome: { type: 'string' },
  },
});

const numOpt = (name, v) => {
  if (v === undefined) return undefined;
  const x = Number(v);
  if (!Number.isFinite(x)) fail(`--${name} expects a number, got "${v}"`);
  return x;
};

async function main() {
  if (opt.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }
  log.verbose = !!opt.verbose;
  const t0 = Date.now();
  const storyboardFile = positionals[0];
  const outFile = resolve(positionals[1] ?? join(TOOLKIT_DIR, 'out', basename(storyboardFile).replace(/\.json$/, '') + '.mp4'));
  const name = basename(outFile).replace(/\.[^.]+$/, '');

  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      await run(bin, ['-version']);
    } catch {
      fail(`${bin} not found on PATH (brew install ffmpeg)`);
    }
  }

  const sb = loadStoryboard(storyboardFile, {
    voice: opt.voice,
    rate: opt.rate,
    tts: opt.tts,
    crossfade: numOpt('crossfade', opt.crossfade),
    music: opt.music ? resolve(opt.music) : undefined,
    musicDb: numOpt('music-db', opt['music-db']),
    captions: opt.captions,
  });
  const { settings } = sb;
  let segments = sb.segments;
  if (opt.only) {
    const keep = new Set(opt.only.split(',').map((x) => Number(x.trim())));
    segments = segments.filter((s) => keep.has(s.n));
    if (!segments.length) fail(`--only ${opt.only} matches no segment (storyboard has ${sb.segments.length})`);
    log.warn(`--only: building ${segments.length} of ${sb.segments.length} segments; the result is a preview, not the full video`);
  }
  const maxDuration = numOpt('max-duration', opt['max-duration']);
  const cacheDir = ensureDir(process.env.FOREMAN_VIDEO_CACHE ? resolve(process.env.FOREMAN_VIDEO_CACHE) : join(TOOLKIT_DIR, 'cache'));
  const noCache = opt.cache === false;
  const captionsOn = settings.captions !== false;

  // ------------------------------------------------------------------ 1. narration
  const narrated = segments.filter((s) => s.narration);
  log.step(`Narration: ${narrated.length} segment${narrated.length === 1 ? '' : 's'} (${settings.tts}, ${settings.voice}, ${settings.rate})`);
  await pool(narrated, Math.max(1, numOpt('jobs', opt.jobs)), async (seg) => {
    seg.audio = await synthesize(seg.narration, { engine: settings.tts, voice: settings.voice, rate: settings.rate, pitch: settings.pitch, volume: settings.volume, cacheDir, noCache });
  });
  for (const seg of narrated) log.info(`${seg.label.padEnd(22)} ${seg.audio.duration.toFixed(1).padStart(5)}s ${seg.audio.cached ? c.dim('(cached)') : 'synthesised'}`);

  // ------------------------------------------------------------------ 2. timeline
  const { totalFrames, crossfadeFrames } = planTimeline(segments, settings);
  const total = secs(totalFrames);
  printTimeline(segments, total, maxDuration);
  if (opt.plan) return;

  const workDir = join(cacheDir, 'work', name);
  rmSync(workDir, { recursive: true, force: true });
  ensureDir(workDir);
  ensureDir(dirname(outFile));

  // ------------------------------------------------------------------ 3. visuals -> clips
  log.step('Rendering');
  const browser = await Browser.launch({ chrome: opt.chrome });
  const clips = [];
  let captionList = null;
  let captionEntries = [];
  try {
    const page = await browser.newPage();
    const encodes = [];
    let firstError = null;
    const inflight = new Set();
    for (const [i, seg] of segments.entries()) {
      if (firstError) break;
      const ctx = { workDir, cacheDir, toolkitDir: TOOLKIT_DIR, settings };
      const tRender = Date.now();
      let visual;
      if (seg.type === 'slide') visual = await renderSlide(page, seg, ctx);
      else if (seg.type === 'image') visual = await renderImage(page, seg, ctx);
      else if (seg.type === 'screenshot') visual = await renderScreenshot(page, seg, ctx);
      else {
        const frames = await renderTerminal(page, seg, { ...ctx, nominalSec: secs(seg.D), captions: captionsOn && !seg.captionOff && !!seg.audio, label: `seg${seg.n}-terminal` });
        visual = { kind: 'sequence', frames };
      }
      log.info(`${seg.label.padEnd(22)} rendered in ${((Date.now() - tRender) / 1000).toFixed(1)}s${visual.frames ? ` (${visual.frames.length} frames)` : ''}`);

      // encode in the background (2 at a time) while Chrome renders the next segment
      while (inflight.size >= 2) await Promise.race(inflight);
      const job = encodeClip(seg, visual, { cacheDir, workDir, settings, draft: opt.draft, force: noCache, crossfadeFrames }).then(
        (r) => {
          clips[i] = r;
          log.info(`${seg.label.padEnd(22)} clip ${r.cached ? c.dim('(cached)') : 'encoded'} ${seg.L} frames`);
        },
        (e) => {
          firstError ??= e;
        },
      );
      inflight.add(job);
      job.finally(() => inflight.delete(job));
      encodes.push(job);
    }
    await Promise.all(encodes);
    if (firstError) throw firstError;

    // ---------------------------------------------------------------- captions
    const entries = [];
    for (const seg of segments) {
      if (!seg.audio) continue;
      const offset = secs(seg.narrationF);
      for (const ch of segmentChunks(seg)) entries.push({ start: offset + ch.start, end: Math.min(offset + ch.end, secs(seg.B + seg.D)), lines: ch.lines });
    }
    entries.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < entries.length; i++) entries[i].end = Math.min(entries[i].end, entries[i + 1].start); // never overlap
    captionEntries = entries.filter((e) => e.end - e.start > 0.05);
    if (captionEntries.length) {
      writeFileSync(outFile.replace(/\.[^.]+$/, '') + '.srt', toSrt(captionEntries));
      if (captionsOn) {
        log.step(`Captions: ${captionEntries.length}`);
        const capPage = await openCaptionPage(browser, { toolkitDir: TOOLKIT_DIR, workDir });
        const dir = ensureDir(join(workDir, 'captions'));
        const blank = join(dir, 'blank.png');
        await renderBlankPng(capPage, blank);
        const lines = [];
        const q = (p) => `file '${p.replace(/'/g, "'\\''")}'`;
        let t = 0;
        const seen = new Map();
        for (const [i, e] of captionEntries.entries()) {
          if (e.start > t + 0.001) lines.push(q(blank), `duration ${(e.start - t).toFixed(6)}`);
          const key = e.lines.join('\n');
          if (!seen.has(key)) {
            const png = join(dir, `cap-${String(i).padStart(3, '0')}.png`);
            await renderCaptionPng(capPage, e.lines, png);
            seen.set(key, png);
          }
          lines.push(q(seen.get(key)), `duration ${(e.end - e.start).toFixed(6)}`);
          t = e.end;
        }
        lines.push(q(blank), `duration ${Math.max(0.1, total - t + 0.5).toFixed(6)}`, q(blank));
        captionList = join(workDir, 'captions.txt');
        writeFileSync(captionList, lines.join('\n') + '\n');
        await capPage.close();
      }
    }
    await page.close();
  } finally {
    await browser.close();
  }

  // ------------------------------------------------------------------ 4. audio
  log.step('Audio');
  const narrationRaw = await buildNarrationTrack(segments, totalFrames, workDir);
  const norm = await normalizeLoudness(narrationRaw, workDir);
  let audioFile = norm.file;
  if (settings.music) {
    log.info(`music bed: ${basename(settings.music)} (${settings.musicDb} dB under the narration)`);
    audioFile = await mixMusic(norm.file, settings.music, { musicDb: settings.musicDb, totalFrames, workDir });
  }

  // ------------------------------------------------------------------ 5. assemble
  log.step('Encoding');
  await assemble({
    clips,
    crossfadeFrames,
    transition: settings.transition,
    draft: opt.draft,
    force: noCache,
    workDir,
    captionList,
    audioFile,
    outFile,
    totalFrames,
    crf: opt.draft ? 26 : Number(opt.crf),
    preset: opt.draft ? 'ultrafast' : opt.preset,
    title: settings.title,
  });

  // ------------------------------------------------------------------ 6. verify + report
  const info = await probe(outFile);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v || !a) fail(`output is missing a ${!v ? 'video' : 'audio'} stream`);
  const dur = Number(info.format.duration);
  const loud = await reportLoudness(outFile).catch(() => null);
  const [fn, fd] = v.r_frame_rate.split('/').map(Number);
  console.error('');
  log.ok(c.bold(outFile));
  log.info(`${v.width}x${v.height} @ ${(fn / fd).toFixed(2)} fps, ${v.codec_name} ${v.profile ?? ''} + ${a.codec_name} ${a.sample_rate} Hz ${a.channels}ch`);
  log.info(`duration ${fmtTime(dur)} (${dur.toFixed(2)}s), ${(statSync(outFile).size / 1e6).toFixed(1)} MB${loud ? `, loudness ${loud.lufs.toFixed(1)} LUFS, true peak ${loud.truePeak.toFixed(1)} dBTP` : ', silent audio'}`);
  if (captionEntries.length) log.info(`captions: ${captionsOn ? 'burned in' : 'not burned in'}; ${outFile.replace(/\.[^.]+$/, '')}.srt written`);
  if (v.width !== 1920 || v.height !== 1080) log.warn(`unexpected resolution ${v.width}x${v.height}`);
  if (Math.abs(dur - total) > 0.15) log.warn(`duration ${dur.toFixed(2)}s differs from the planned ${total.toFixed(2)}s`);
  if (dur > maxDuration) log.warn(`${c.bold(`video is ${fmtTime(dur)}, over the ${fmtTime(maxDuration)} limit`)}: shorten narration or cut a segment (node build.mjs ${storyboardFile} --plan shows per-segment lengths)`);
  log.info(`built in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!opt['keep-work']) rmSync(workDir, { recursive: true, force: true });
  else log.info(`work files kept in ${workDir}`);
}

function printTimeline(segments, total, maxDuration) {
  console.error('');
  console.error(c.dim('   #  type        start     len   speech   text'));
  for (const s of segments) {
    const text = (s.narration ?? '(no narration)').slice(0, 52) + ((s.narration?.length ?? 0) > 52 ? '...' : '');
    console.error(`   ${String(s.n).padStart(2)}  ${s.type.padEnd(10)}  ${fmtTime(secs(s.B)).padStart(6)}  ${secs(s.D).toFixed(1).padStart(5)}s  ${(s.audio ? s.audio.duration.toFixed(1) + 's' : '-').padStart(6)}   ${text}`);
  }
  const over = total > maxDuration;
  console.error(`\n   total ${(over ? c.yellow : c.green)(fmtTime(total))} (limit ${fmtTime(maxDuration)})\n`);
}

main().catch((e) => {
  if (e instanceof UserError) console.error('\n' + c.red('error: ') + e.message);
  else console.error('\n' + c.red('error: ') + (log.verbose ? (e.stack ?? e.message) : e.message) + (log.verbose ? '' : c.dim('\n(run with -v for the stack trace and ffmpeg commands)')));
  process.exit(1);
});
