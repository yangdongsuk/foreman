// Tiny HTML template engine for slides ({{var}} placeholders).
//
//   {{name}}              HTML-escaped text. In text context also: **bold**, `code`, newline -> <br>
//   {{{name}}}            raw HTML (use for inline SVG, e.g. {{{diagram}}})
//   {{name|fallback}}     fallback text when the var is missing or empty
//   {{a.b}}               nested lookup
//   {{#each list max=5}}  ...{{this}} / {{this.label}} / {{@n}} (1-based) / {{@index}}...  {{/each}}
//                         a missing list renders nothing; more than `max` items is an error
//
// A missing scalar var is an error (listed all at once); vars the template never reads produce a warning.
import { escapeHtml, fail } from './util.mjs';

const inlineMarkup = (escaped) =>
  escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\r?\n/g, '<br>');

const lookupPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function renderTemplate(src, vars, { name = 'template' } = {}) {
  const used = new Set();
  const missing = new Set();

  const resolve = (path, scope) => {
    path = path.trim();
    if (scope && (path === 'this' || path.startsWith('this.') || path.startsWith('@'))) {
      if (path.startsWith('@')) return scope[path];
      return path === 'this' ? scope.this : lookupPath(scope.this, path.slice(5));
    }
    used.add(path.split('.')[0]);
    return lookupPath(vars, path);
  };

  const substitute = (text, scope) =>
    text.replace(
      /\{\{\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}\}\}|\{\{\s*([^}|#/][^}|]*?)\s*(?:\|([^}]*))?\}\}/g,
      (m, rawKey, rawDef, key, def, offset) => {
        const raw = rawKey !== undefined;
        const path = raw ? rawKey : key;
        const fallback = raw ? rawDef : def;
        let v = resolve(path, scope);
        if (v === undefined || v === null || v === '') {
          if (fallback === undefined) {
            missing.add(path.trim());
            return '';
          }
          v = fallback;
        }
        if (typeof v === 'object') fail(`${name}: "${path.trim()}" is a ${Array.isArray(v) ? 'list' : 'object'} but is used as text`);
        v = String(v);
        if (raw) return v;
        const esc = escapeHtml(v);
        const inTag = text.lastIndexOf('<', offset) > text.lastIndexOf('>', offset);
        return inTag ? esc : inlineMarkup(esc);
      },
    );

  const expanded = src.replace(
    /\{\{#each\s+([\w.$-]+)([^}]*)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (m, key, opts, body) => {
      const list = resolve(key, null);
      if (list === undefined || list === null) return '';
      if (!Array.isArray(list)) fail(`${name}: "${key}" must be a list (JSON array)`);
      const max = /max=(\d+)/.exec(opts)?.[1];
      if (max && list.length > Number(max)) fail(`${name}: "${key}" has ${list.length} items but this template shows at most ${max}`);
      return list.map((item, i) => substitute(body, { this: item, '@index': i, '@n': i + 1 })).join('');
    },
  );
  const html = substitute(expanded, null);

  if (missing.size) {
    fail(`${name}: missing template var${missing.size > 1 ? 's' : ''}: ${[...missing].join(', ')} (set ${missing.size > 1 ? 'them' : 'it'} under "vars" in the storyboard)`);
  }
  const warnings = Object.keys(vars ?? {})
    .filter((k) => !used.has(k))
    .map((k) => `${name}: var "${k}" is not used by the template (typo?)`);
  return { html, warnings };
}
