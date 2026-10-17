// ANSI log -> styled cell grid -> HTML rows. Only what a captured CLI session needs:
//   SGR colors (16 / 256 / truecolor), bold, dim, italic, underline, strike, inverse, hidden;
//   \r overwrite, backspace, tabs, erase-in-line, simple cursor up/down/left/right;
//   everything else (OSC titles, hyperlinks, private modes, cursor positioning, charsets) is stripped.
import { escapeHtml } from './util.mjs';

export const THEME = {
  fg: '#D8DCEB',
  bg: '#0C1224',
  // 0-7 normal, 8-15 bright. Tuned for readability on the navy window body.
  palette: [
    '#1B2036', '#FF6B81', '#4ADE9A', '#F5C26B', '#5AA2FF', '#A98BFF', '#4DD0E1', '#D5DAEC',
    '#5C6690', '#FF8FA0', '#7CF0B8', '#FFD98A', '#82BBFF', '#C4AEFF', '#7BE3F0', '#FFFFFF',
  ],
};

// ---------------------------------------------------------------- styles
const styles = new Map();
const mkStyle = (o) => {
  const full = { fg: null, bg: null, b: false, d: false, i: false, u: false, s: false, inv: false, hid: false, ...o };
  const key = JSON.stringify(full);
  if (!styles.has(key)) styles.set(key, Object.freeze(full));
  return styles.get(key);
};
export const DEFAULT_STYLE = mkStyle({});
const SPACER = { c: '', s: DEFAULT_STYLE, w: 0 };
const blank = () => ({ c: ' ', s: DEFAULT_STYLE, w: 1 });

const hex2 = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
const rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const CUBE = [0, 95, 135, 175, 215, 255];

export function xterm256(n, theme = THEME) {
  if (n < 16) return theme.palette[n];
  if (n < 232) {
    const k = n - 16;
    return rgbHex(CUBE[Math.floor(k / 36)], CUBE[Math.floor(k / 6) % 6], CUBE[k % 6]);
  }
  const g = 8 + (n - 232) * 10;
  return rgbHex(g, g, g);
}

const blend = (a, b, t) => {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return rgbHex(...pa.map((v, i) => v * t + pb[i] * (1 - t)));
};

const colorHex = (c, theme) => (c === null ? null : typeof c === 'number' ? xterm256(c, theme) : c);

/** Resolve a style to concrete CSS colors + flags (inverse, dim, hidden applied). */
export function resolveStyle(st, theme = THEME) {
  let fg = colorHex(st.fg, theme) ?? theme.fg;
  let bg = colorHex(st.bg, theme); // null = transparent (window body)
  if (st.inv) [fg, bg] = [bg ?? theme.bg, fg];
  if (st.d) fg = blend(fg, theme.bg, 0.55);
  if (st.hid) fg = bg ?? theme.bg;
  return { fg, bg, b: st.b, i: st.i, u: st.u, s: st.s };
}

// ---------------------------------------------------------------- character widths
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3],
  [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
const ZERO = [
  [0x300, 0x36f], [0x200b, 0x200f], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0x20d0, 0x20ff], [0xfe20, 0xfe2f],
  [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
];
const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

export function cellWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

// ---------------------------------------------------------------- parser
function applySgr(params, st) {
  const groups = params === '' ? ['0'] : params.split(';');
  let o = { ...st };
  const ext = (which, sub) => {
    // sub: [5, n] or [2, r, g, b]
    if (sub[0] === 5 && Number.isFinite(sub[1])) o[which] = Math.max(0, Math.min(255, sub[1]));
    else if (sub[0] === 2 && sub.slice(1, 4).every(Number.isFinite)) o[which] = rgbHex(sub[1], sub[2], sub[3]);
  };
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (g.includes(':')) {
      // colon form: 38:5:n  38:2:r:g:b  38:2::r:g:b  4:3
      const sub = g.split(':').map((x) => (x === '' ? 0 : Number(x)));
      const head = sub[0];
      if (head === 38 || head === 48) {
        const which = head === 38 ? 'fg' : 'bg';
        ext(which, sub[1] === 2 && sub.length >= 6 ? [2, sub[3], sub[4], sub[5]] : sub.slice(1));
      } else if (head === 4) o.u = sub[1] !== 0;
      continue;
    }
    const n = g === '' ? 0 : Number(g);
    if (!Number.isFinite(n)) continue;
    if (n === 38 || n === 48) {
      const which = n === 38 ? 'fg' : 'bg';
      const mode = Number(groups[gi + 1]);
      if (mode === 5) {
        ext(which, [5, Number(groups[gi + 2])]);
        gi += 2;
      } else if (mode === 2) {
        ext(which, [2, Number(groups[gi + 2]), Number(groups[gi + 3]), Number(groups[gi + 4])]);
        gi += 4;
      }
      continue;
    }
    if (n === 0) o = { fg: null, bg: null, b: false, d: false, i: false, u: false, s: false, inv: false, hid: false };
    else if (n === 1) o.b = true;
    else if (n === 2) o.d = true;
    else if (n === 3) o.i = true;
    else if (n === 4 || n === 21) o.u = true;
    else if (n === 7) o.inv = true;
    else if (n === 8) o.hid = true;
    else if (n === 9) o.s = true;
    else if (n === 22) (o.b = false), (o.d = false);
    else if (n === 23) o.i = false;
    else if (n === 24) o.u = false;
    else if (n === 27) o.inv = false;
    else if (n === 28) o.hid = false;
    else if (n === 29) o.s = false;
    else if (n >= 30 && n <= 37) o.fg = n - 30;
    else if (n === 39) o.fg = null;
    else if (n >= 40 && n <= 47) o.bg = n - 40;
    else if (n === 49) o.bg = null;
    else if (n >= 90 && n <= 97) o.fg = n - 90 + 8;
    else if (n >= 100 && n <= 107) o.bg = n - 100 + 8;
    // 5/6 blink, 53 overline, 58/59 underline color: ignored
  }
  return mkStyle(o);
}

/**
 * Parse ANSI text into rows of cells: Cell = { c: string, s: style, w: 0|1|2 } (w 0 = spacer after a wide char).
 * Trailing blank rows and trailing default-style spaces are dropped.
 */
export function parseAnsi(input, { tabWidth = 8 } = {}) {
  const cps = Array.from(String(input));
  const rows = [[]];
  let r = 0;
  let c = 0;
  let style = DEFAULT_STYLE;
  const ensureRow = (i) => {
    while (rows.length <= i) rows.push([]);
  };

  const put = (ch, w) => {
    ensureRow(r);
    const row = rows[r];
    while (row.length < c) row.push(blank());
    // overwriting half of a wide char: blank the other half
    if (row[c]?.w === 0 && c > 0) row[c - 1] = blank();
    if (row[c]?.w === 2 && row[c + 1]?.w === 0) row[c + 1] = blank();
    row[c] = { c: ch, s: style, w };
    if (w === 2) {
      if (row[c + 1]?.w === 2 && row[c + 2]?.w === 0) row[c + 2] = blank();
      row[c + 1] = SPACER;
    }
    c += w;
  };

  const attach = (ch, cp) => {
    // combining mark / ZWJ / variation selector: glue onto the previous visible cell
    const row = rows[r];
    if (!row || c === 0) return;
    let k = c - 1;
    if (row[k]?.w === 0 && k > 0) k--;
    const prev = row[k];
    if (!prev) return;
    prev.c += ch;
    // VS16 asks for emoji presentation: occupy two cells
    if (cp === 0xfe0f && prev.w === 1 && prev.c.codePointAt(0) >= 0x2190) {
      prev.w = 2;
      row[c] = SPACER;
      c += 1;
    }
  };

  const csi = (params, fin) => {
    if (/^[<=>?]/.test(params)) return; // private modes: ?25l, ?2004h, >4;2m ...
    const nums = params === '' ? [] : params.split(';').map((x) => (x === '' ? NaN : Number(x)));
    const arg = (def) => (Number.isFinite(nums[0]) && nums[0] > 0 ? Math.min(nums[0], 200) : def);
    switch (fin) {
      case 'm':
        style = applySgr(params, style);
        break;
      case 'K': {
        ensureRow(r);
        const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
        if (mode === 0) rows[r].length = Math.min(rows[r].length, c);
        else if (mode === 1) for (let k = 0; k <= Math.min(c, rows[r].length - 1); k++) rows[r][k] = blank();
        else rows[r] = [];
        break;
      }
      case 'J': {
        const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
        if (mode === 0) {
          ensureRow(r);
          rows[r].length = Math.min(rows[r].length, c);
          rows.length = r + 1;
        } else if (mode === 2 || mode === 3) {
          rows.length = 0;
          rows.push([]);
          r = 0;
          c = 0;
        }
        break;
      }
      case 'A': r = Math.max(0, r - arg(1)); break;
      case 'B': r += arg(1); ensureRow(r); break;
      case 'E': r += arg(1); c = 0; ensureRow(r); break;
      case 'F': r = Math.max(0, r - arg(1)); c = 0; break;
      case 'C': c += arg(1); break;
      case 'D': c = Math.max(0, c - arg(1)); break;
      case 'G': c = Math.max(0, arg(1) - 1); break;
      case 'X': {
        ensureRow(r);
        for (let k = c; k < c + arg(1) && k < rows[r].length; k++) rows[r][k] = blank();
        break;
      }
      default: break; // H f s u h l r S T P @ L M ... : cursor positioning / scrolling, ignored
    }
  };

  for (let i = 0; i < cps.length; ) {
    const ch = cps[i];
    if (ch === '\x1b') {
      const n = cps[i + 1];
      if (n === '[') {
        let j = i + 2;
        let params = '';
        while (j < cps.length && cps[j] >= '\x30' && cps[j] <= '\x3f') params += cps[j++];
        while (j < cps.length && cps[j] >= '\x20' && cps[j] <= '\x2f') j++; // intermediates
        const fin = cps[j];
        if (fin === undefined) break;
        if (fin >= '\x40' && fin <= '\x7e') csi(params, fin);
        i = j + 1;
        continue;
      }
      if (n === ']' || n === 'P' || n === 'X' || n === '^' || n === '_') {
        // string sequences (OSC title / hyperlink, DCS, APC): drop until BEL or ST
        let j = i + 2;
        while (j < cps.length) {
          if (cps[j] === '\x07') { j++; break; }
          if (cps[j] === '\x1b' && cps[j + 1] === '\\') { j += 2; break; }
          j++;
        }
        i = j;
        continue;
      }
      if (n !== undefined && n >= '\x20' && n <= '\x2f') { i += 3; continue; } // ESC ( B and friends
      i += 2; // ESC 7, ESC 8, ESC =, ESC M ...
      continue;
    }
    i++;
    if (ch === '\n') { r++; c = 0; ensureRow(r); continue; }
    if (ch === '\r') { c = 0; continue; }
    if (ch === '\b') { c = Math.max(0, c - 1); continue; }
    if (ch === '\t') { c += tabWidth - (c % tabWidth); continue; }
    const cp = ch.codePointAt(0);
    const w = cellWidth(cp);
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // BEL, NUL, SO/SI, DEL, C1 ...
    if (w === 0) attach(ch, cp);
    else put(ch, w);
  }

  // tidy: trim trailing default-style blanks, drop trailing empty rows
  for (const row of rows) {
    while (row.length && row[row.length - 1].c.trim() === '' && row[row.length - 1].s.bg === null && !row[row.length - 1].s.inv) row.pop();
  }
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

// ---------------------------------------------------------------- layout helpers
export const rowWidth = (row) => row.reduce((n, cell) => n + cell.w, 0);

/** Word-aware wrap of one logical row to `cols` cells, with a hanging indent equal to its leading spaces. */
export function wrapRow(row, cols) {
  if (rowWidth(row) <= cols) return [row];
  let lead = 0;
  while (lead < row.length && row[lead].c === ' ') lead++;
  const indent = Math.min(lead, Math.floor(cols / 3));
  const out = [];
  let rest = row;
  let first = true;
  for (let guard = 0; guard < 500; guard++) {
    const limit = first ? cols : cols - indent;
    if (rowWidth(rest) <= limit) {
      out.push(first ? rest : [...Array.from({ length: indent }, blank), ...rest]);
      return out;
    }
    // largest k such that cells 0..k fit in `limit`
    let w = 0;
    let k = -1;
    for (let i = 0; i < rest.length; i++) {
      if (w + rest[i].w > limit) break;
      w += rest[i].w;
      k = i;
    }
    if (k < 0) k = 0; // pathological: a single cell wider than the limit
    // prefer to break at the last space in the second half of the line
    let cut = k;
    let drop = 0;
    for (let i = k + 1; i > Math.floor(k * 0.4); i--) {
      if (rest[i]?.c === ' ' && i <= k + 1) {
        cut = i - 1;
        drop = 1;
        break;
      }
    }
    const head = rest.slice(0, cut + 1);
    while (head.length && head[head.length - 1].c === ' ') head.pop();
    out.push(first ? head : [...Array.from({ length: indent }, blank), ...head]);
    rest = rest.slice(cut + 1 + drop);
    while (rest.length && rest[0].c === ' ') rest.shift();
    first = false;
    if (!rest.length) return out;
  }
  return out;
}

// ---------------------------------------------------------------- HTML
// Chars the monospace font is trusted to draw at exactly 1 cell; everything else gets a fixed-width box so a
// fallback glyph (check marks, arrows, emoji, CJK) can never push the rest of the line out of its column.
const nativeGlyph = (cp) => cp <= 0x7e || (cp >= 0xa0 && cp <= 0xff) || (cp >= 0x2500 && cp <= 0x259f);

const styleAttr = (() => {
  const cache = new Map();
  return (st, theme) => {
    const key = st;
    if (cache.has(key)) return cache.get(key);
    const rs = resolveStyle(st, theme);
    const css = [];
    if (rs.fg !== theme.fg) css.push(`color:${rs.fg}`);
    if (rs.bg) css.push(`background:${rs.bg}`);
    const cls = [rs.b && 'b', rs.i && 'i', rs.u && 'u', rs.s && 's'].filter(Boolean).join(' ');
    const out = !css.length && !cls ? '' : `<span${cls ? ` class="${cls}"` : ''}${css.length ? ` style="${css.join(';')}"` : ''}>`;
    cache.set(key, out);
    return out;
  };
})();

export function rowToHtml(row, theme = THEME) {
  let html = '';
  let i = 0;
  while (i < row.length) {
    const st = row[i].s;
    let text = '';
    let j = i;
    while (j < row.length && row[j].s === st) {
      const cell = row[j];
      if (cell.w !== 0) {
        const cp = cell.c.codePointAt(0);
        text += nativeGlyph(cp) && cell.c.length === String.fromCodePoint(cp).length
          ? escapeHtml(cell.c)
          : `<span class="g" style="width:${cell.w}ch">${escapeHtml(cell.c)}</span>`;
      }
      j++;
    }
    const open = styleAttr(st, theme);
    html += open ? `${open}${text}</span>` : text;
    i = j;
  }
  return html;
}

/** Plain text of a row (used by tests and for sizing). */
export const rowText = (row) => row.map((cell) => cell.c).join('');
