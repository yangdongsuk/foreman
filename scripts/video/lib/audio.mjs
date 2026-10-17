// Narration track (frame-exact), loudness normalization (two-pass loudnorm, -16 LUFS), optional music bed.
import { join } from 'node:path';
import { FPS, fail, ffmpeg, log, mediaDuration, run } from './util.mjs';

const SR = 48000;
const SAMPLES_PER_FRAME = SR / FPS; // 1600
export const TARGET_LUFS = -16;
const TP = -1.5;

/** loudnorm in analysis mode. Its JSON report is printed at loglevel info, so this bypasses the quiet ffmpeg() wrapper. */
async function measureFile(file, extraInput = []) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'info', ...extraInput, '-i', file, '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TP}:LRA=11:print_format=json`, '-f', 'null', '-']);
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) fail(`could not read a loudness measurement for ${file}`);
  const j = JSON.parse(m[0]);
  return { I: Number(j.input_i), TP: Number(j.input_tp), LRA: Number(j.input_lra), thresh: Number(j.input_thresh), offset: Number(j.target_offset) };
}

/** One stereo 48 kHz wav, exactly totalFrames long, narration placed at each segment's nominal start + lead. */
export async function buildNarrationTrack(segments, totalFrames, workDir) {
  const inputs = [];
  const filters = [];
  const labels = [];
  segments.forEach((seg, i) => {
    const dur = seg.D * SAMPLES_PER_FRAME;
    if (seg.audio) {
      const idx = inputs.length / 2;
      inputs.push('-i', seg.audio.audio);
      filters.push(`[${idx}:a]aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${seg.leadF * SAMPLES_PER_FRAME}S:all=1,apad,atrim=end_sample=${dur},asetpts=N/SR/TB[a${i}]`);
    } else {
      filters.push(`anullsrc=r=${SR}:cl=stereo,atrim=end_sample=${dur},asetpts=N/SR/TB[a${i}]`);
    }
    labels.push(`[a${i}]`);
  });
  filters.push(`${labels.join('')}concat=n=${segments.length}:v=0:a=1[out]`);
  const out = join(workDir, 'narration-raw.wav');
  await ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s24le', '-ar', String(SR), out]);
  const d = await mediaDuration(out);
  if (Math.abs(d - totalFrames / FPS) > 0.05) log.warn(`narration track is ${d.toFixed(2)}s, expected ${(totalFrames / FPS).toFixed(2)}s`);
  return out;
}

export async function normalizeLoudness(file, workDir) {
  const m = await measureFile(file);
  if (!Number.isFinite(m.I) || m.I < -70) {
    log.info('no narration audio: skipping loudness normalization');
    return { file, before: m };
  }
  const out = join(workDir, 'narration-norm.wav');
  const filter = `loudnorm=I=${TARGET_LUFS}:TP=${TP}:LRA=11:measured_I=${m.I}:measured_TP=${m.TP}:measured_LRA=${m.LRA}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true,aresample=${SR}`;
  await ffmpeg(['-i', file, '-af', filter, '-c:a', 'pcm_s24le', '-ar', String(SR), out]);
  return { file: out, before: m };
}

/** Quiet music bed under the narration: looped, faded, held `musicDb` dB below the narration loudness. */
export async function mixMusic(narrationFile, musicFile, { musicDb, totalFrames, workDir }) {
  const total = totalFrames / FPS;
  const probe = await measureFile(musicFile, ['-t', '60']);
  if (!Number.isFinite(probe.I)) fail(`cannot measure loudness of music file ${musicFile}`);
  const gain = TARGET_LUFS - musicDb - probe.I;
  const fadeOut = Math.min(3, total / 3);
  const bed = join(workDir, 'music-bed.wav');
  await ffmpeg([
    '-stream_loop', '-1', '-t', String(total), '-i', musicFile,
    '-af', `aresample=${SR},aformat=channel_layouts=stereo,volume=${gain.toFixed(2)}dB,afade=t=in:d=2,afade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`,
    '-c:a', 'pcm_s24le', '-ar', String(SR), bed,
  ]);
  const out = join(workDir, 'mix.wav');
  await ffmpeg(['-i', narrationFile, '-i', bed, '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[m]', '-map', '[m]', '-c:a', 'pcm_s24le', '-ar', String(SR), out]);
  return out;
}

export async function reportLoudness(file) {
  const m = await measureFile(file);
  return Number.isFinite(m.I) ? { lufs: m.I, truePeak: m.TP } : null; // null = silent
}
