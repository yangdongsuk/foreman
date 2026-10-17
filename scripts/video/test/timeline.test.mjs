import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimeline } from '../lib/storyboard.mjs';
import { kenBurns } from '../lib/clips.mjs';

const seg = (n, audioSec, extra = {}) => ({ n, label: `segment ${n}`, lead: 0.2, tail: 0.2, audio: audioSec ? { duration: audioSec } : null, ...extra });
const settings = { crossfade: 0.3 };

test('segment length = narration + 0.4 s, frame exact', () => {
  const segs = [seg(1, 3.0), seg(2, 5.5)];
  const { totalFrames } = planTimeline(segs, settings);
  assert.equal(segs[0].D, Math.ceil(3.0 * 30) + 12);
  assert.equal(segs[1].D, Math.ceil(5.5 * 30) + 12);
  assert.equal(totalFrames, segs[0].D + segs[1].D);
});

test('crossfades are centred on the nominal boundaries and never change the total length', () => {
  const segs = [seg(1, 4), seg(2, 4), seg(3, 4)];
  const { totalFrames, crossfadeFrames: X } = planTimeline(segs, settings);
  assert.equal(X, 9);
  assert.equal(segs[0].headF, 0);
  assert.equal(segs[2].tailF, 0);
  for (let i = 0; i < 2; i++) assert.equal(segs[i].tailF + segs[i + 1].headF, X); // the overlap is exactly X frames
  // clip lengths minus overlaps == nominal total
  assert.equal(segs.reduce((n, s) => n + s.L, 0) - 2 * X, totalFrames);
  // narration starts `lead` after the nominal start
  assert.equal(segs[1].narrationF, segs[0].D + 6);
});

test('hard cuts: no head/tail frames', () => {
  const segs = [seg(1, 2), seg(2, 2)];
  planTimeline(segs, { crossfade: 0 });
  assert.deepEqual(segs.map((s) => [s.headF, s.tailF, s.L === s.D]), [[0, 0, true], [0, 0, true]]);
});

test('explicit duration holds the visual; too short is extended with a warning', () => {
  const a = seg(1, 2, { duration: 10 });
  planTimeline([a], settings);
  assert.equal(a.D, 300);
  const b = seg(2, 6, { duration: 3 });
  planTimeline([b], settings);
  assert.equal(b.D, Math.ceil(6 * 30) + 12);
});

test('silent segments need an explicit duration and have a minimum length', () => {
  const s = seg(1, 0, { duration: 0.5 });
  planTimeline([s], settings);
  assert.ok(s.D >= 15);
});

test('kenBurns presets: zoom in/out, pans stay inside the image', () => {
  const zin = kenBurns({ motion: 'in', zoom: 1.2, focus: [0.6, 0.4] });
  assert.deepEqual([zin.from.zoom, zin.to.zoom, zin.to.x, zin.to.y], [1, 1.2, 0.6, 0.4]);
  const zout = kenBurns({ motion: 'out' });
  assert.equal(zout.from.zoom, 1.12);
  assert.equal(zout.to.zoom, 1);
  const pan = kenBurns({ motion: 'left', zoom: 1.25 });
  // the camera centre travels from the right-most to the left-most position that keeps the view inside the image
  assert.ok(Math.abs(pan.from.x - (1 - 0.5 / 1.25)) < 1e-9 && Math.abs(pan.to.x - 0.5 / 1.25) < 1e-9);
  assert.ok(pan.from.x + 0.5 / 1.25 <= 1 + 1e-9 && pan.to.x - 0.5 / 1.25 >= -1e-9);
  const custom = kenBurns({ motion: { from: { zoom: 1 }, to: { zoom: 9, x: 0.2 } } });
  assert.equal(custom.to.zoom, 4); // clamped
});
