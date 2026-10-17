import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../lib/template.mjs';

const r = (src, vars) => renderTemplate(src, vars, { name: 't.html' });

test('escapes text, raw triple braces pass through', () => {
  assert.equal(r('<p>{{a}}</p>', { a: '<b>&' }).html, '<p>&lt;b&gt;&amp;</p>');
  assert.equal(r('<div>{{{svg}}}</div>', { svg: '<svg/>' }).html, '<div><svg/></div>');
});

test('inline markup only in text context, not in attributes', () => {
  assert.equal(r('<p>{{a}}</p>', { a: 'x **b** `c`\ny' }).html, '<p>x <strong>b</strong> <code>c</code><br>y</p>');
  assert.equal(r('<a href="{{u}}">{{u}}</a>', { u: 'http://x/**y**' }).html, '<a href="http://x/**y**">http://x/<strong>y</strong></a>');
});

test('fallbacks', () => {
  assert.equal(r('{{a|none}} {{b|none}}', { a: '' }).html, 'none none');
  assert.equal(r('{{a|none}}', { a: 0 }).html, '0');
});

test('missing vars are reported together', () => {
  assert.throws(() => r('{{a}} {{b}}', {}), /missing template vars: a, b/);
});

test('unused vars warn', () => {
  assert.deepEqual(r('{{a}}', { a: 1, typo: 2 }).warnings, ['t.html: var "typo" is not used by the template (typo?)']);
});

test('each: strings, objects, index, max, missing list', () => {
  const t = '<ul>{{#each items max=3}}<li>{{@n}}. {{this}}</li>{{/each}}</ul>';
  assert.equal(r(t, { items: ['a', 'b'] }).html, '<ul><li>1. a</li><li>2. b</li></ul>');
  assert.equal(r('{{#each l}}<a href="{{this.url}}">{{this.label}}</a>{{/each}}', { l: [{ url: 'u', label: 'L' }] }).html, '<a href="u">L</a>');
  assert.throws(() => r(t, { items: [1, 2, 3, 4] }), /at most 3/);
  assert.equal(r('{{#each nothing}}x{{/each}}ok', {}).html, 'ok');
  assert.throws(() => r('{{#each items}}{{this}}{{/each}}', { items: 'nope' }), /must be a list/);
});

test('objects used as text are rejected', () => {
  assert.throws(() => r('{{a}}', { a: { x: 1 } }), /used as text/);
});

test('outer vars are visible inside each', () => {
  assert.equal(r('{{#each l}}{{pre}}{{this}}{{/each}}', { l: ['a', 'b'], pre: '-' }).html, '-a-b');
});
