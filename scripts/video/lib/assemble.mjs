// Final assembly. Clips arrive as { a?, body, b? } pieces (see clips.mjs). Each boundary gets a tiny crossfade clip
// built from the previous clip's `b` and the next clip's `a`; the video is then ONE sequential concatenation
// (body, transition, body, ...) with the caption overlay and a single H.264 + AAC encode.
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { FPS, HEIGHT, ffmpeg, sha1 } from './util.mjs';
import { STRIP_H } from './captions.mjs';

const COLOR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const normalise = (i) => `[${i}:v]fps=${FPS},setpts=N/(${FPS}*TB),fps=${FPS},format=yuv420p,setsar=1`; // xfade is strict about rate/timebase

async function transitionClip(prev, next, { X, transition, draft, force }) {
  const key = sha1('xfade-v1', basename(prev.b), basename(next.a), transition, X, !!draft).slice(0, 24);
  const out = join(dirname(prev.b), `xf-${key}.mp4`);
  if (!force && existsSync(out)) return out;
  const tmp = out.replace(/\.mp4$/, `.${process.pid}.part.mp4`);
  await ffmpeg([
    '-i', prev.b,
    '-i', next.a,
    '-filter_complex', `${normalise(0)}[x];${normalise(1)}[y];[x][y]xfade=transition=${transition}:duration=${(X / FPS).toFixed(6)}:offset=0[v]`,
    '-map', '[v]',
    '-frames:v', String(X),
    '-r', String(FPS),
    '-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'veryfast', '-crf', draft ? '23' : '14',
    '-bf', '0', '-pix_fmt', 'yuv420p', '-g', String(FPS),
    ...COLOR_TAGS,
    '-an',
    tmp,
  ]);
  renameSync(tmp, out);
  return out;
}

export async function assemble({ clips, crossfadeFrames: X, transition, draft, force, captionList, audioFile, outFile, totalFrames, crf, preset, title, workDir }) {
  // 1. ordered parts: body_0, T_1, body_1, T_2, ...
  const parts = [];
  for (const [i, clip] of clips.entries()) {
    if (i > 0 && X > 0) parts.push(await transitionClip(clips[i - 1], clip, { X, transition, draft, force }));
    parts.push(clip.body);
  }
  const q = (p) => `file '${p.replace(/'/g, "'\\''")}'`;
  const videoList = join(workDir, 'video.txt');
  writeFileSync(videoList, parts.map(q).join('\n') + '\n');

  // 2. one encode: concat -> captions -> H.264, plus the finished audio
  const args = ['-f', 'concat', '-safe', '0', '-i', videoList];
  let next = 1;
  let capIdx = null;
  if (captionList) {
    capIdx = next++;
    args.push('-f', 'concat', '-safe', '0', '-i', captionList);
  }
  const audioIdx = next++;
  args.push('-i', audioFile);

  const f = [`[0:v]fps=${FPS},setpts=N/(${FPS}*TB),format=yuv420p,setsar=1[vx]`];
  let last = 'vx';
  if (capIdx !== null) {
    f.push(`[${capIdx}:v]fps=${FPS},format=rgba[cap]`);
    f.push(`[${last}][cap]overlay=x=0:y=${HEIGHT - STRIP_H}:format=auto:eof_action=pass[vc]`);
    last = 'vc';
  }
  f.push(`[${last}]format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vout]`);

  await ffmpeg(
    [
      ...args,
      '-filter_complex', f.join(';'),
      '-map', '[vout]',
      '-map', `${audioIdx}:a`,
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', String(crf),
      '-profile:v', 'high',
      '-level:v', '4.1',
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      '-g', String(FPS * 2),
      ...COLOR_TAGS,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-ac', '2',
      '-t', (totalFrames / FPS).toFixed(6),
      '-movflags', '+faststart',
      ...(title ? ['-metadata', `title=${title}`] : []),
      outFile,
    ],
    { totalFrames, label: 'encoding' },
  );
}
