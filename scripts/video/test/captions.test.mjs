import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunks, layoutLines, splitText, LINE_CHARS, MAX_CHARS } from '../lib/captions.mjs';
import { cuesFromText, parseSubtitles, splitSentences } from '../lib/tts.mjs';

test('parseSubtitles reads edge-tts SRT and WebVTT', () => {
  const srt = '1\n00:00:00,050 --> 00:00:04,833\nHello there.\n\n2\n00:00:04,833 --> 00:01:09,988\nSecond one.\n';
  assert.deepEqual(parseSubtitles(srt), [
    { start: 0.05, end: 4.833, text: 'Hello there.' },
    { start: 4.833, end: 69.988, text: 'Second one.' },
  ]);
  const vtt = 'WEBVTT\n\n00:01.500 --> 00:03.000\n<b>Hi</b> you\n';
  assert.deepEqual(parseSubtitles(vtt), [{ start: 1.5, end: 3, text: 'Hi you' }]);
});

test('splitSentences keeps punctuation and handles a missing final stop', () => {
  assert.deepEqual(splitSentences('One. Two! Three? Four'), ['One.', 'Two!', 'Three?', 'Four']);
});

test('splitText: short text untouched, long text split into <= max pieces at natural breaks', () => {
  assert.deepEqual(splitText('Short sentence.'), ['Short sentence.']);
  const long = 'The agent verifies the plan, pays fractions of a cent for its own tools, checks every criterion, and releases the payment on chain.';
  const parts = splitText(long, MAX_CHARS);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= MAX_CHARS, p);
  assert.equal(parts.join(' '), long);
  assert.ok(/,$/.test(parts[0]), `prefers to break after a comma: ${parts[0]}`);
});

test('layoutLines: at most two balanced lines', () => {
  assert.deepEqual(layoutLines('fits on one line'), ['fits on one line']);
  const lines = layoutLines('The owner funds each job through a policy contract on Arc and the agent approves within the cap');
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0].length - lines[1].length) < 25);
  assert.ok(lines.every((l) => l.length <= LINE_CHARS + 12));
});

test('never strands a short function word at the end of a line', () => {
  const [a] = layoutLines('We give every freelancer a clear brief and then the agent reviews it all for the owner');
  assert.ok(!/\b(a|the|of|to)$/.test(a), a);
});

test('buildChunks: contiguous, ordered, inside the narration, never more than 2 lines', () => {
  const cues = cuesFromText('First a short one. Then a much longer sentence that has to be split into several readable captions so nothing overflows the box, even with commas, and more words.', 0.05, 11);
  const chunks = buildChunks(cues, { narrationEnd: 11 });
  assert.ok(chunks.length >= 3);
  let prev = 0;
  for (const c of chunks) {
    assert.ok(c.start >= prev - 1e-9 && c.end > c.start && c.end <= 11 + 1e-9);
    assert.ok(c.lines.length >= 1 && c.lines.length <= 2);
    prev = c.start;
  }
});

test('cuesFromText spreads time by weight and covers the whole span', () => {
  const cues = cuesFromText('Hi. A much longer second sentence here.', 1, 5);
  assert.equal(cues[0].start, 1);
  assert.ok(Math.abs(cues.at(-1).end - 5) < 1e-9);
  assert.ok(cues[1].end - cues[1].start > cues[0].end - cues[0].start);
});
