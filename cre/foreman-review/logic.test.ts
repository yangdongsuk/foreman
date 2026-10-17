import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { canonicalHash as nodeCanonicalHash, canonicalJSON as nodeCanonicalJSON } from "../../agent/canonical.mjs"
import {
  canonicalHash,
  canonicalJSON,
  decide,
  deterministicJudge,
  hangulPercent,
  mergeJudgments,
  parseGemini,
  parsePrUrl,
  type Evidence,
} from "./logic"

const pilot = JSON.parse(readFileSync(new URL("./payloads/pilot-pr1.json", import.meta.url), "utf8"))
const criteria: string[] = pilot.criteria

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  source: "github",
  repo: "yangdongsuk/foreman",
  number: 1,
  title: "Add Korean README",
  state: "closed",
  merged: true,
  changedFiles: 1,
  additions: 114,
  deletions: 0,
  baseSha: "a",
  headSha: "b",
  files: [{ filename: "README.ko.md", status: "added", additions: 114, deletions: 0 }],
  addedHangulPct: 70,
  ...over,
})

describe("canonical JSON matches agent/canonical.mjs", () => {
  const sample = { b: 1n, a: [{ z: "한글", y: null, x: undefined }], c: { d: 2 } }
  test("same bytes and hash", () => {
    expect(canonicalJSON(sample)).toBe(nodeCanonicalJSON(sample))
    expect(canonicalHash(sample)).toBe(nodeCanonicalHash(sample))
    expect(canonicalJSON(sample)).toBe('{"a":[{"y":null,"z":"한글"}],"b":"1","c":{"d":2}}')
  })
})

describe("parsePrUrl", () => {
  test("accepts PR urls, rejects others", () => {
    expect(parsePrUrl("https://github.com/yangdongsuk/foreman/pull/1")).toEqual({ owner: "yangdongsuk", repo: "foreman", number: 1 })
    expect(() => parsePrUrl("https://github.com/yangdongsuk/foreman")).toThrow()
    expect(() => parsePrUrl("https://evil.example/yangdongsuk/foreman/pull/1")).toThrow()
  })
})

describe("deterministic judgment on the pilot criteria", () => {
  test("good PR: criterion 1 met, the rest unverified -> escalate", () => {
    const r = deterministicJudge(criteria, evidence())
    expect(r.map((x) => x.met)).toEqual([true, null, null, null, null])
    expect(decide(r, 1, evidence()).verdict).toBe(2)
  })
  test("wrong file name -> unmet -> revision", () => {
    const ev = evidence({ files: [{ filename: "docs/ko.md", status: "added", additions: 1, deletions: 0 }] })
    const r = deterministicJudge(criteria, ev)
    expect(r[0].met).toBe(false)
    expect(decide(r, 1, ev).verdict).toBe(1)
  })
  test("extra file changed fails the only-that-file criterion", () => {
    const ev = evidence({ files: [...evidence().files, { filename: "agent/review.mjs", status: "modified", additions: 1, deletions: 1 }] })
    expect(deterministicJudge(criteria, ev)[4].met).toBe(false)
  })
  test("README.md link edit is allowed", () => {
    const ev = evidence({ files: [...evidence().files, { filename: "README.md", status: "modified", additions: 1, deletions: 0 }] })
    expect(deterministicJudge(criteria, ev)[4].met).toBe(null)
  })
  test("English-only translation fails the Hangul criterion", () => {
    expect(deterministicJudge(criteria, evidence({ addedHangulPct: 2 }))[3].met).toBe(false)
  })
})

describe("guardrails", () => {
  const all = (met: boolean | null) => criteria.map((criterion) => ({ criterion, met, reason: "" }))
  test("all met -> approve", () => expect(decide(all(true), 0, evidence()).verdict).toBe(0))
  test("unmet -> revision", () => expect(decide(all(false), 2, evidence()).verdict).toBe(1))
  test("unmet with revisions spent -> escalate", () => {
    const d = decide(all(false), 3, evidence())
    expect(d.verdict).toBe(2)
    expect(d.guardrails[0]).toContain("revision_budget_spent")
  })
  test("unverified -> escalate", () => expect(decide([...all(true).slice(1), { criterion: "x", met: null, reason: "" }], 0, evidence()).verdict).toBe(2))
  test("closed unmerged PR is never approved", () => expect(decide(all(true), 0, evidence({ merged: false })).verdict).toBe(2))
})

describe("gemini parsing", () => {
  const wrap = (obj: unknown) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] })
  test("aligns by position and keeps our criterion text", () => {
    const r = parseGemini(wrap({ verdicts: [{ criterion: "rewritten", met: true, reason: "ok" }] }), ["A", "B"])
    expect(r).toEqual([
      { criterion: "A", met: true, reason: "ok" },
      { criterion: "B", met: null, reason: "unverified: the model gave no verdict for this criterion" },
    ])
  })
  test("throws on empty answers so the workflow falls back", () => {
    expect(() => parseGemini(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }), ["A"])).toThrow()
  })
  test("deterministic disproof overrides a model 'met'", () => {
    const llm = [{ criterion: "A", met: true as boolean | null, reason: "looks fine" }]
    const det = [{ criterion: "A", met: false as boolean | null, reason: "wrong file" }]
    expect(mergeJudgments(llm, det)[0].met).toBe(false)
  })
})

test("hangulPercent ignores code fences, urls and removed lines", () => {
  const patch = ["+++ b/x.md", "+안녕하세요 세계", "+```", "+const english = 1", "+```", "-removed english", "+https://example.com/english"].join("\n")
  expect(hangulPercent([{ patch }])).toBe(100)
})
