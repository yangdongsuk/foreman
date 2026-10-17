import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnsi, rowText, rowToHtml, wrapRow, rowWidth, xterm256, resolveStyle, THEME } from '../lib/ansi.mjs';

const text = (s) => parseAnsi(s).map(rowText);
const style = (s, row = 0, col = 0) => parseAnsi(s)[row][col].s;

test('plain text and newlines (LF, CRLF)', () => {
  assert.deepEqual(text('a\nb\r\nc'), ['a', 'b', 'c']);
  assert.deepEqual(text('a\n\n\nb\n\n'), ['a', '', '', 'b']); // trailing blank rows dropped
});

test('16 colors, bright colors, reset', () => {
  assert.equal(style('\x1b[31mx').fg, 1);
  assert.equal(style('\x1b[92mx').fg, 10);
  assert.equal(style('\x1b[41mx').bg, 1);
  assert.equal(style('\x1b[101mx').bg, 9);
  assert.equal(style('\x1b[31;1mx\x1b[0m').fg, 1);
  const rows = parseAnsi('\x1b[31mred\x1b[0mplain');
  assert.equal(rows[0][3].s.fg, null);
});

test('256-color and truecolor, semicolon and colon forms', () => {
  assert.equal(style('\x1b[38;5;208mx').fg, 208);
  assert.equal(style('\x1b[48;5;21mx').bg, 21);
  assert.equal(style('\x1b[38;2;39;117;202mx').fg, '#2775ca');
  assert.equal(style('\x1b[38:2::124:92:255mx').fg, '#7c5cff');
  assert.equal(style('\x1b[38:5:99mx').fg, 99);
  assert.equal(xterm256(196), '#ff0000');
  assert.equal(xterm256(16), '#000000');
  assert.equal(xterm256(232), '#080808');
  assert.equal(xterm256(9), THEME.palette[9]);
});

test('bold, dim, italic, underline, strike, inverse, and their resets', () => {
  const s = style('\x1b[1;2;3;4;9;7mx');
  assert.deepEqual([s.b, s.d, s.i, s.u, s.s, s.inv], [true, true, true, true, true, true]);
  const t = parseAnsi('\x1b[1;2mA\x1b[22mB')[0][1].s;
  assert.deepEqual([t.b, t.d], [false, false]);
  const r = resolveStyle(style('\x1b[7;31mx'));
  assert.equal(r.bg, THEME.palette[1]); // inverse swaps fg/bg
  const dim = resolveStyle(style('\x1b[2mx'));
  assert.notEqual(dim.fg, THEME.fg);
});

test('same style objects are interned (run merging relies on it)', () => {
  const row = parseAnsi('\x1b[32mab\x1b[32mcd')[0];
  assert.equal(row[0].s, row[3].s);
});

test('carriage return overwrites; erase in line', () => {
  assert.deepEqual(text('loading 10%\rloading 90%'), ['loading 90%']);
  assert.deepEqual(text('abcdef\rXY'), ['XYcdef']);
  assert.deepEqual(text('spinner\r\x1b[2Kdone'), ['done']);
  assert.deepEqual(text('hello world\x1b[6D\x1b[K!'), ['hello!']);
});

test('backspace and tab', () => {
  assert.deepEqual(text('ab\bX'), ['aX']);
  assert.deepEqual(text('a\tb'), ['a       b']);
});

test('cursor movement: up redraws a previous line; right pads', () => {
  assert.deepEqual(text('one\ntwo\n\x1b[2A\x1b[2Konce'), ['once', 'two']);
  assert.deepEqual(text('a\x1b[3Cb'), ['a   b']);
});

test('private modes, OSC titles/hyperlinks, charsets, other escapes are stripped', () => {
  assert.deepEqual(text('\x1b[?25lhi\x1b[?25h'), ['hi']);
  assert.deepEqual(text('\x1b]0;window title\x07ok'), ['ok']);
  assert.deepEqual(text('\x1b]8;;https://x.io\x1b\\link\x1b]8;;\x1b\\'), ['link']);
  assert.deepEqual(text('\x1b(Bplain\x1b=\x1b>'), ['plain']);
  assert.deepEqual(text('a\x1b[10;5Hb'), ['ab']); // absolute positioning ignored
  assert.deepEqual(text('a\x07b\x00c'), ['abc']);
  assert.deepEqual(text('\x1b[2Jfresh'), ['fresh']);
});

test('truncated escape at end of input does not throw', () => {
  assert.deepEqual(text('ok\x1b['), ['ok']);
  assert.deepEqual(text('ok\x1b'), ['ok']);
});

test('wide characters take two cells and keep following columns aligned', () => {
  const row = parseAnsi('a✅b')[0];
  assert.equal(rowWidth(row), 4);
  const html = rowToHtml(row);
  assert.match(html, /<span class="g" style="width:2ch">/);
});

test('combining marks attach to the previous cell', () => {
  const row = parseAnsi('éx')[0];
  assert.equal(rowWidth(row), 2);
});

test('HTML: escapes, merges runs, wraps non-native glyphs', () => {
  const html = rowToHtml(parseAnsi('\x1b[32m<ok>\x1b[0m ✓ done')[0]);
  assert.match(html, /^<span style="color:#[0-9a-f]{6}">&lt;ok&gt;<\/span> <span class="g" style="width:1ch">✓<\/span> done$/i);
  assert.equal(rowToHtml(parseAnsi('─│ box')[0]), '─│ box'); // box drawing is native
});

test('wrapRow: word wrap with hanging indent, hard wrap fallback, width never exceeded', () => {
  const row = parseAnsi('    ' + 'word '.repeat(30).trim())[0];
  const out = wrapRow(row, 40);
  assert.ok(out.length > 1);
  for (const r of out) assert.ok(rowWidth(r) <= 40, rowText(r));
  assert.ok(rowText(out[1]).startsWith('    word'));
  const long = parseAnsi('x'.repeat(100))[0];
  const hard = wrapRow(long, 30);
  assert.deepEqual(hard.map(rowWidth), [30, 30, 30, 10]);
  assert.equal(wrapRow(parseAnsi('short')[0], 40).length, 1);
});
