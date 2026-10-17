// Tool: GET a URL and report whether it is up, how fast, and what is on the page.
import { readCapped, decodeBytes, htmlToText, htmlFacts, clip, ssrfError } from './util.mjs';

const MAX_BODY = 1_000_000;
const MAX_REDIRECTS = 5;

export const httpCheck = {
  name: 'http-check',
  method: 'GET',
  path: '/tools/http-check',
  price: 1000n, // 0.001 USDC
  description: 'Fetch a public URL (10s timeout, follows redirects) and report status, latency, title, first h1, meta description, link count and a text sample. Use it to verify that a deployed site or page exists and says what the freelancer claims.',
  params: { url: { in: 'query', type: 'string', required: true, description: 'http(s) URL to fetch' } },

  validate({ url }) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must be http or https';
    } catch {
      return 'url is required and must be a valid http(s) URL';
    }
    return null;
  },

  async run({ url }) {
    const started = Date.now();
    const signal = AbortSignal.timeout(10_000);
    let current = new URL(url);
    try {
      // Redirects are followed by hand so every hop passes the private-address check.
      for (let hop = 0; ; hop++) {
        const blocked = await ssrfError(current);
        if (blocked) return { url, ok: false, status: 0, error: blocked };
        const res = await fetch(current, {
          redirect: 'manual',
          signal,
          headers: { 'user-agent': 'ForemanToolServer/0.1 (+https://github.com/yangdongsuk/foreman)', accept: 'text/html,*/*;q=0.8' },
        });
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) return { url, finalUrl: current.href, ok: false, status: res.status, error: 'too many redirects' };
          current = new URL(loc, current);
          continue;
        }
        const contentType = res.headers.get('content-type') || '';
        const { bytes, truncated } = await readCapped(res, MAX_BODY);
        const body = decodeBytes(bytes, contentType);
        const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
        const isText = isHtml || /^text\/|json|xml/i.test(contentType);
        return {
          url,
          finalUrl: current.href,
          status: res.status,
          ok: res.ok,
          ms: Date.now() - started,
          contentType,
          bytes: bytes.length,
          truncated,
          ...(isHtml ? htmlFacts(body) : { title: '', h1: '', metaDescription: '', linkCount: 0 }),
          // Page text stays short; a raw text file (a README, a diff) is returned whole so a reviewer can check all of it.
          textSample: isHtml ? clip(htmlToText(body), 3000) : isText ? clip(body.trim(), 16000) : '',
        };
      }
    } catch (e) {
      const reason = e.name === 'TimeoutError' ? 'timeout after 10s' : e.cause?.code || e.cause?.errors?.[0]?.code || e.message;
      return { url, finalUrl: current.href, ok: false, status: 0, ms: Date.now() - started, error: `fetch failed: ${reason}` };
    }
  },
};
