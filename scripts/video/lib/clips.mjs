// Encode one segment's visuals (stills, Ken Burns, or a frame sequence) into a CFR 30 fps H.264 clip of exactly
// seg.L frames. Rendering is always redone (cheap); the expensive encode is cached by the content of the frames.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FPS, WIDTH, HEIGHT, ensureDir, ffmpeg, fail, sha1 } from './util.mjs';

const ENCODER_VERSION = 'clip-v2';

// RGB PNG -> BT.709 limited-range YUV 4:2:0, tagged as such, so brand colors survive.
const TO_YUV = 'scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p';
const COLOR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

const bgHex = (c) => '0x' + c.replace('#', '');
const fmt = (n) => Number(n.toFixed(5)).toString();

const fitFilter = (w, h, bg) =>
  `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${bgHex(bg)},setsar=1`;

/** Ken Burns camera path -> zoompan expressions. View center is (x, y) in 0..1, zoom >= 1, smoothstep easing. */
export function kenBurns(seg) {
  const m = seg.motion;
  const [fx, fy] = seg.focus ?? [0.5, 0.5];
  let from;
  let to;
  if (typeof m === 'object') {
    from = { zoom: 1, x: 0.5, y: 0.5, ...m.from };
    to = { zoom: 1, x: 0.5, y: 0.5, ...m.to };
  } else if (m === 'in') {
    from = { zoom: 1, x: 0.5, y: 0.5 };
    to = { zoom: seg.zoom ?? 1.12, x: fx, y: fy };
  } else if (m === 'out') {
    from = { zoom: seg.zoom ?? 1.12, x: fx, y: fy };
    to = { zoom: 1, x: 0.5, y: 0.5 };
  } else {
    // pans: constant zoom, camera travels the full width/height available at that zoom
    const z = seg.zoom ?? 1.15;
    const lo = 0.5 / z;
    const hi = 1 - 0.5 / z;
    const v = { left: [hi, lo, 'x'], right: [lo, hi, 'x'], up: [hi, lo, 'y'], down: [lo, hi, 'y'] }[m];
    from = { zoom: z, x: 0.5, y: 0.5 };
    to = { zoom: z, x: 0.5, y: 0.5 };
    from[v[2]] = v[0];
    to[v[2]] = v[1];
  }
  const clampZ = (z) => Math.min(4, Math.max(1, z));
  from.zoom = clampZ(from.zoom);
  to.zoom = clampZ(to.zoom);
  return { from, to };
}

function zoompanFilter(seg, frames) {
  const { from, to } = kenBurns(seg);
  const p = `(on/${frames - 1})`;
  const e = `(${p}*${p}*(3-2*${p}))`; // smoothstep: gentle start and stop
  const lerp = (a, b) => `${fmt(a)}+(${fmt(b - a)})*${e}`;
  const z = lerp(from.zoom, to.zoom);
  const cx = lerp(from.x, to.x);
  const cy = lerp(from.y, to.y);
  return `zoompan=z='${z}':x='(${cx})*iw-iw/zoom/2':y='(${cy})*ih-ih/zoom/2':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`;
}

const sha1File = (f) => sha1(readFileSync(f));

/**
 * visual: { kind: 'still', png } | { kind: 'sequence', frames: [{ png, t }] }  (t = seconds after nominal start)
 *
 * The clip (seg.L frames) is encoded as up to three files from ONE filter pass:
 *   a     the first X frames  (crossfaded with the previous clip)      only if there is a previous segment
 *   body  everything in between
 *   b     the last X frames   (crossfaded with the next clip)          only if there is a next segment
 * so the final assembly is a plain concatenation (bounded memory, trivial timestamps) plus tiny transition clips.
 * Returns { a?, body, b?, cached } with absolute file paths. Files are cached by the content of the frames.
 */
export async function encodeClip(seg, visual, { cacheDir, workDir, settings, draft, force, crossfadeFrames: X }) {
  const L = seg.L;
  const common = { v: ENCODER_VERSION, L, X, prev: seg.hasPrev, next: seg.hasNext, bg: settings.background, draft: !!draft };
  let key;
  let inputArgs;
  let chain;

  if (visual.kind === 'still') {
    const useKb = !!seg.motion;
    key = sha1(common, 'still', sha1File(visual.png), useKb ? { m: seg.motion, z: seg.zoom, f: seg.focus } : null, seg.fit);
    const canvas = useKb ? [WIDTH * 2, HEIGHT * 2] : [WIDTH, HEIGHT];
    inputArgs = useKb ? ['-i', visual.png] : ['-loop', '1', '-framerate', String(FPS), '-i', visual.png];
    chain = [fitFilter(...canvas, settings.background), ...(useKb ? [zoompanFilter(seg, L)] : []), TO_YUV].join(',');
  } else {
    // frame sequence: concat list with per-frame durations aligned to the 30 fps grid
    const starts = [];
    for (const [k, f] of visual.frames.entries()) {
      const s = k === 0 ? 0 : seg.headF + Math.round(f.t * FPS);
      if (s >= L) continue;
      if (starts.length && s <= starts[starts.length - 1].s) {
        starts[starts.length - 1].png = f.png; // two states inside one video frame: the later one wins
        continue;
      }
      starts.push({ s, png: f.png });
    }
    const q = (p) => `file '${p.replace(/'/g, "'\\''")}'`;
    const lines = [];
    starts.forEach((cur, i) => lines.push(q(cur.png), `duration ${(((starts[i + 1]?.s ?? L) - cur.s) / FPS).toFixed(6)}`));
    lines.push(q(starts[starts.length - 1].png)); // concat quirk: the last duration is ignored
    const listFile = join(ensureDir(workDir), `seg-${seg.n}-frames.txt`);
    writeFileSync(listFile, lines.join('\n') + '\n');
    key = sha1(common, 'seq', starts.map((x) => [x.s, sha1File(x.png)]), seg.fit);
    inputArgs = ['-f', 'concat', '-safe', '0', '-i', listFile];
    chain = [`fps=${FPS}`, fitFilter(WIDTH, HEIGHT, settings.background), TO_YUV].join(',');
  }

  const hasA = X > 0 && seg.hasPrev;
  const hasB = X > 0 && seg.hasNext;
  const ranges = [];
  if (hasA) ranges.push({ name: 'a', start: 0, end: X });
  ranges.push({ name: 'body', start: hasA ? X : 0, end: hasB ? L - X : L });
  if (hasB) ranges.push({ name: 'b', start: L - X, end: L });

  const dir = ensureDir(join(cacheDir, 'clips'));
  const outs = ranges.map((r) => ({ ...r, file: join(dir, `${key.slice(0, 24)}-${r.name}.mp4`) }));
  const result = Object.fromEntries(outs.map((o) => [o.name, o.file]));
  if (!force && outs.every((o) => existsSync(o.file))) return { ...result, cached: true };

  const graph =
    `[0:v]${chain},split=${outs.length}${outs.map((_, i) => `[p${i}]`).join('')};` +
    outs.map((o, i) => `[p${i}]trim=start_frame=${o.start}:end_frame=${o.end},setpts=N/(${FPS}*TB)[o${i}]`).join(';');
  const tmps = outs.map((o) => o.file.replace(/\.mp4$/, '.part.mp4'));
  await ffmpeg(
    [
      ...inputArgs,
      '-filter_complex', graph,
      ...outs.flatMap((o, i) => [
        '-map', `[o${i}]`,
        '-frames:v', String(o.end - o.start),
        '-r', String(FPS),
        '-c:v', 'libx264',
        '-preset', draft ? 'ultrafast' : 'veryfast',
        '-crf', draft ? '23' : '14',
        '-bf', '0', // no B-frames: exact timestamps from frame 0, tiny decoder buffers
        '-pix_fmt', 'yuv420p',
        '-g', String(FPS),
        ...COLOR_TAGS,
        '-an',
        tmps[i],
      ]),
    ],
    { totalFrames: L, label: seg.label },
  );
  outs.forEach((o, i) => {
    if (!existsSync(tmps[i])) fail(`${seg.label}: ffmpeg produced no ${o.name} clip`);
    renameSync(tmps[i], o.file);
  });
  return { ...result, cached: false };
}
