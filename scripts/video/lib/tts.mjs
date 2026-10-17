// Text-to-speech with a content-addressed cache. Engines:
//   edge  Microsoft neural voices via the edge-tts CLI (default, needs network; subtitles come back as sentence cues)
//   say   macOS offline voices (fallback if Microsoft is unreachable; captions are timed from character counts)
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, fail, ffmpeg, log, mediaDuration, run, sha1 } from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLKIT = join(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_VOICE = 'en-US-AndrewNeural';

/** Parse SRT or WebVTT text into [{start, end, text}] (seconds). */
export function parseSubtitles(text) {
  const cues = [];
  const t = (h, m, s, ms) => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const m = lines[i].match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    const body = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (body) cues.push({ start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]), text: body });
  }
  return cues;
}

// Which edge-tts to run: $EDGE_TTS_BIN, the local venv from setup.sh, PATH, then the MoneyPrinterTurbo venv.
// Resolved once (TTS jobs run in parallel) and version-checked: edge-tts < 7.3 is rejected by Microsoft with a 403.
let edgeBin = null;
function resolveEdgeBin() {
  edgeBin ??= (async () => {
    const candidates = [
      process.env.EDGE_TTS_BIN,
      join(TOOLKIT, '.venv/bin/edge-tts'),
      'edge-tts',
      join(process.env.HOME ?? '', 'project/MoneyPrinterTurbo/.venv/bin/edge-tts'),
    ].filter(Boolean);
    for (const bin of candidates) {
      if (bin.includes('/') && !existsSync(bin)) continue;
      try {
        const { stdout, stderr } = await run(bin, ['--version'], { timeout: 20_000 });
        const v = (stdout + stderr).match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
        if (v && (v[0] < 7 || (v[0] === 7 && v[1] < 3))) {
          log.warn(`${bin} is edge-tts ${v.join('.')}; versions below 7.3 get "403 Invalid response status" from Microsoft. Run scripts/video/setup.sh to install a current one locally.`);
        }
        return bin;
      } catch {
        /* try the next candidate */
      }
    }
    fail('edge-tts not found. Run scripts/video/setup.sh (installs it into scripts/video/.venv), or set EDGE_TTS_BIN=/path/to/edge-tts, or use --tts say.');
  })();
  return edgeBin;
}

export function splitSentences(text) {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? [text];
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Timing weight of a piece of text: characters, plus a pause allowance for commas and the like. */
export const weight = (s) => s.length + 4 * (s.match(/[,;:—–]/g) ?? []).length;

/** Sentence cues spread over [from, to] in proportion to their weight. */
export function cuesFromText(text, from, to) {
  const sentences = splitSentences(text);
  const total = sentences.reduce((n, s) => n + weight(s), 0) || 1;
  let t = from;
  return sentences.map((s) => {
    const end = t + ((to - from) * weight(s)) / total;
    const cue = { start: t, end, text: s };
    t = end;
    return cue;
  });
}

async function edgeSynth(text, { voice, rate, pitch, volume }, mp3, srt) {
  const bin = await resolveEdgeBin();
  const textFile = mp3.replace(/\.mp3$/, '.txt');
  writeFileSync(textFile, text);
  const args = ['--voice', voice, `--rate=${rate}`, `--pitch=${pitch}`, `--volume=${volume}`, '--file', textFile, '--write-media', mp3, '--write-subtitles', srt];
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await run(bin, args, { timeout: 180_000 });
      if (!existsSync(mp3) || !existsSync(srt)) throw new Error('edge-tts produced no output');
      await mediaDuration(mp3); // throws on an empty / corrupt file
      return;
    } catch (e) {
      lastErr = e;
      rmSync(mp3, { force: true });
      rmSync(srt, { force: true });
      if (attempt < 4) {
        log.debug(`TTS attempt ${attempt} failed (${String(e.message).split('\n')[0]}); retrying`);
        await sleep(1500 * attempt);
      }
    }
  }
  const msg = String(lastErr.message);
  const hint = /403|handshake/i.test(msg)
    ? '\nMicrosoft rejected the request (403). Old edge-tts versions are blocked: run scripts/video/setup.sh to install >= 7.3.1 locally, or build with --tts say (macOS offline voices).'
    : /Cannot connect|ClientConnector|Name or service|getaddrinfo|timed out/i.test(msg)
      ? '\nCannot reach Microsoft TTS. Check your network, or build with --tts say (macOS offline voices).'
      : '';
  fail(`TTS failed for: "${text.slice(0, 60)}"\n${msg.split('\n').filter((l) => l.trim()).slice(-5).join('\n')}${hint}`);
}

async function saySynth(text, { voice, rate }, mp3, srt) {
  const sayVoice = !voice || /Neural/i.test(voice) ? 'Samantha' : voice;
  const pct = Number(String(rate).replace('%', '')) || 0;
  const wpm = Math.round(180 * (1 + pct / 100));
  const aiff = mp3.replace(/\.mp3$/, '.aiff');
  await run('say', ['-v', sayVoice, '-r', String(wpm), '-o', aiff, '--', text], { timeout: 180_000 });
  await ffmpeg(['-i', aiff, '-c:a', 'libmp3lame', '-b:a', '96k', '-ar', '24000', '-ac', '1', mp3]);
  rmSync(aiff, { force: true });
  const d = await mediaDuration(mp3);
  const cues = cuesFromText(text, 0.05, Math.max(0.1, d - 0.05));
  const ts = (x) => {
    const ms = Math.round(x * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  writeFileSync(srt, cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n'));
}

/**
 * Synthesize narration (cached by text + voice settings).
 * Returns { audio, duration, cues, cached }.
 */
export async function synthesize(text, { engine = 'edge', voice = DEFAULT_VOICE, rate = '+5%', pitch = '+0Hz', volume = '+0%', cacheDir, noCache = false }) {
  const spoken = text.replace(/\s+/g, ' ').trim();
  if (!spoken) fail('empty narration text');
  const key = sha1('tts-v1', engine, voice ?? '', rate, pitch, volume, spoken).slice(0, 20);
  const dir = ensureDir(join(cacheDir, 'tts'));
  const mp3 = join(dir, `${key}.mp3`);
  const srt = join(dir, `${key}.srt`);
  let cached = true;
  if (noCache || !existsSync(mp3) || !existsSync(srt)) {
    cached = false;
    const tmpMp3 = join(dir, `${key}.part.mp3`);
    const tmpSrt = join(dir, `${key}.part.srt`);
    // a trailing full stop gives the voice a natural falling ending
    const input = /[.!?…]["')\]]*$/.test(spoken) ? spoken : `${spoken}.`;
    if (engine === 'say') await saySynth(input, { voice, rate }, tmpMp3, tmpSrt);
    else if (engine === 'edge') await edgeSynth(input, { voice, rate, pitch, volume }, tmpMp3, tmpSrt);
    else fail(`unknown tts engine "${engine}" (use edge or say)`);
    renameSync(tmpMp3, mp3); // atomic: an interrupted run never leaves a half-written cache entry
    renameSync(tmpSrt, srt);
    rmSync(join(dir, `${key}.part.txt`), { force: true });
    writeFileSync(join(dir, `${key}.txt`), spoken + '\n'); // readable record of what this cache entry says
  }
  const duration = await mediaDuration(mp3);
  const cues = parseSubtitles(readFileSync(srt, 'utf8'));
  return { audio: mp3, duration, cues: cues.length ? cues : cuesFromText(spoken, 0.05, duration - 0.05), cached };
}
