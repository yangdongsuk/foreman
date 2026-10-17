import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBytes } from 'viem';
import { canonicalJSON, canonicalHash } from './canonical.mjs';

test('keys are sorted at every depth and whitespace is dropped', () => {
  assert.equal(canonicalJSON({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test('key order never changes the hash', () => {
  assert.equal(canonicalHash({ x: 1, y: [1, 2], z: 'é' }), canonicalHash({ z: 'é', y: [1, 2], x: 1 }));
});

test('bigint becomes a decimal string, undefined fields are dropped like JSON.stringify', () => {
  assert.equal(canonicalJSON({ n: 10n ** 20n, skip: undefined }), '{"n":"100000000000000000000"}');
});

test('hash is keccak256 over the UTF-8 bytes of the canonical JSON', () => {
  const v = { a: 'ü', b: [1] };
  assert.equal(canonicalHash(v), keccak256(toBytes('{"a":"ü","b":[1]}')));
});

test('a record survives a JSON round trip with the same hash (what the dashboard relies on)', () => {
  const rec = { amountUnits: '500000', steps: [{ receipt: { cumulative: '2000' }, args: { url: 'https://x.y/?a=1&b=2' } }], ok: true, n: 0.5 };
  assert.equal(canonicalHash(JSON.parse(JSON.stringify(rec))), canonicalHash(rec));
});
