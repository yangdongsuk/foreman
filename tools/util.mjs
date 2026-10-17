// Small helpers shared by the tool implementations: capped body reads, HTML -> text, SSRF guard.
import dns from 'node:dns/promises';
import net from 'node:net';

/** Read at most `max` bytes of a fetch Response body. Returns { bytes: Uint8Array, truncated }. */
export async function readCapped(res, max) {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= max) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, bytes.length - off);
    bytes.set(c.subarray(0, take), off);
    off += take;
  }
  return { bytes, truncated };
}

export function decodeBytes(bytes, contentType = '') {
  const label = /charset=([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', hellip: '...', copy: '(c)' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ' '; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();
export const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

/** Visible text of an HTML document: scripts/styles dropped, tags stripped, whitespace collapsed. */
export function htmlToText(html) {
  return squash(decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|nav|main|pre|table)\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  ));
}

export function htmlFacts(html, baseUrl) {
  const inner = (re) => {
    const m = re.exec(html);
    return m ? squash(decodeEntities(m[1].replace(/<[^>]+>/g, ''))) : '';
  };
  let metaDescription = '';
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (/\bname\s*=\s*["']?description["']?/i.test(tag)) {
      const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      if (c) { metaDescription = squash(decodeEntities(c[1] ?? c[2] ?? '')); break; }
    }
  }
  return {
    title: inner(/<title[^>]*>([\s\S]*?)<\/title>/i),
    h1: inner(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i),
    metaDescription,
    linkCount: (html.match(/<a\s[^>]*\bhref\s*=/gi) || []).length,
    // Link targets matter when a deliverable must link somewhere; resolve them so a reviewer can compare URLs.
    links: [...html.matchAll(/<a\s[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 40).map((m) => {
      const raw = decodeEntities(m[1] ?? m[2] ?? '');
      let href = raw;
      try { if (baseUrl && !raw.startsWith('data:')) href = new URL(raw, baseUrl).href; } catch { /* keep raw */ }
      return { text: squash(decodeEntities(m[3].replace(/<[^>]+>/g, ''))).slice(0, 80), href: href.slice(0, 300) };
    }),
  };
}

function privateV4(a) {
  const [p, q] = a.split('.').map(Number);
  return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q < 128) || (p === 169 && q === 254)
    || (p === 172 && q >= 16 && q < 32) || (p === 192 && q === 168) || (p === 192 && q === 0) || p >= 224;
}
function privateAddress(a) {
  if (net.isIPv4(a)) return privateV4(a);
  const v6 = a.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateV4(mapped[1]);
  // WHATWG URL rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * The server fetches URLs on behalf of callers, so refuse anything that resolves to a private,
 * loopback or link-local address. ALLOW_PRIVATE_URLS=1 turns this off (local tests only).
 * Returns an error string or null.
 */
export async function ssrfError(url) {
  if (process.env.ALLOW_PRIVATE_URLS === '1') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return privateAddress(host) ? 'refusing to fetch a private address' : null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'refusing to fetch a private address';
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => privateAddress(a.address))) return 'refusing to fetch a private address';
  } catch {
    return null; // unresolvable hosts fail later with a clear fetch error, which is a valid check result
  }
  return null;
}
