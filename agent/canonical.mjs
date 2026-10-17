// Canonical JSON: the single serialisation every hash in Foreman is computed over.
// Sorted keys, no whitespace, bigint -> decimal string. The dashboard re-implements these
// ~15 lines in the browser to recompute reasonHash, so keep this file dependency-free.
import { keccak256, toBytes } from 'viem';

export function canonicalJSON(value) {
  return JSON.stringify(normalize(value));
}

function normalize(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toJSON === 'function') return normalize(v.toJSON());
  if (Array.isArray(v)) return v.map(normalize);
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (v[k] !== undefined) out[k] = normalize(v[k]);
  }
  return out;
}

/** keccak256 over the UTF-8 bytes of the canonical JSON: the value written on chain. */
export function canonicalHash(value) {
  return keccak256(toBytes(canonicalJSON(value)));
}
