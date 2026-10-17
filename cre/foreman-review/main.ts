// Foreman review workflow (Chainlink CRE).
//
// Orchestration layer between Foreman's agent, GitHub, an LLM and Arc:
//
//   HTTP trigger { jobId, index, deliverableUrl, criteria, amountUnits, revisionsUsed }
//     1. evidence   GitHub REST API (PR + files + base README), DON consensus on the result
//     2. judgment   Gemini (secret GEMINI_API_KEY, one call shared via cacheSettings),
//                   or deterministic checks when the key is missing / the call fails
//     3. guardrails unmet -> revision, revisions spent -> escalate, unverified -> escalate, all met -> approve
//     4. record     canonical JSON decision record -> reasonHash, evidenceHash (keccak256)
//     5. report     ABI-encode (jobId, index, verdict, reasonHash, evidenceHash), sign via
//                   runtime.report() and write it to the receiver on Arc through the Forwarder
//
// The escrow cap is enforced elsewhere (ForemanPolicy on Arc mainnet); this workflow attests the review.
import {
  bytesToHex,
  consensusIdenticalAggregation,
  decodeJson,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  HTTPCapability,
  HTTPClient,
  ok,
  Runner,
  text,
  TxStatus,
  type HTTPPayload,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk"
import { encodeAbiParameters, parseAbiParameters } from "viem"
import { z } from "zod"
import {
  buildPrompt,
  buildRecord,
  canonicalJSON,
  decide,
  deterministicJudge,
  hangulPercent,
  GEMINI_RESPONSE_SCHEMA,
  GEMINI_SYSTEM,
  mergeJudgments,
  parseGemini,
  parsePrUrl,
  validateRequest,
  type CriterionResult,
  type Evidence,
  type EvidenceContext,
  type Method,
  type ReviewRequest,
} from "./logic"

const configSchema = z.object({
  /** Contract on `chainSelectorName` implementing IReceiver (ABI of the report: uint256,uint256,uint8,bytes32,bytes32). */
  receiverAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainSelectorName: z.string(),
  /** Gas limit for the report transaction, as a decimal string. */
  gasLimit: z.string(),
  geminiModel: z.string(),
  /** Per-call HTTP timeout. The simulator allows at most 10s per call. */
  httpTimeout: z.string(),
})
export type Config = z.infer<typeof configSchema>

const GEMINI_SECRET_ID = "GEMINI_API_KEY"
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "foreman-cre-workflow",
  "X-GitHub-Api-Version": "2022-11-28",
}

// ---------------------------------------------------------------------------------------------
// Step 1: evidence from GitHub (runs on every node; results must be identical to reach consensus)
// ---------------------------------------------------------------------------------------------

type GithubPull = {
  title: string
  state: string
  merged: boolean
  changed_files: number
  additions: number
  deletions: number
  base: { sha: string }
  head: { sha: string }
}
type GithubFile = { filename: string; status: string; additions: number; deletions: number; patch?: string }

const fetchEvidence = (deliverableUrl: string, timeout: string) => (nodeRuntime: NodeRuntime<Config>): string => {
  const { owner, repo, number } = parsePrUrl(deliverableUrl)
  const http = new HTTPClient()
  const get = (url: string) => http.sendRequest(nodeRuntime, { url, method: "GET", headers: GITHUB_HEADERS, timeout }).result()

  const api = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
  const prResp = get(api)
  if (!ok(prResp)) throw new Error(`GitHub PR request failed: HTTP ${prResp.statusCode}`)
  const pr = JSON.parse(text(prResp)) as GithubPull

  const filesResp = get(`${api}/files?per_page=100`)
  if (!ok(filesResp)) throw new Error(`GitHub files request failed: HTTP ${filesResp.statusCode}`)
  const files = JSON.parse(text(filesResp)) as GithubFile[]

  const evidence: Evidence = {
    source: "github",
    repo: `${owner}/${repo}`,
    number,
    title: pr.title,
    state: pr.state,
    merged: pr.merged,
    changedFiles: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
    addedHangulPct: hangulPercent(files.filter((f) => f.filename.endsWith(".md") && f.patch).map((f) => ({ patch: f.patch as string }))),
  }
  return JSON.stringify(evidence)
}

/** Bulk text for the LLM: the changed lines and the README the translation is checked against. */
const fetchContext = (nodeRuntime: NodeRuntime<Config>, ev: Evidence, timeout: string): EvidenceContext => {
  const http = new HTTPClient()
  const get = (url: string) => http.sendRequest(nodeRuntime, { url, method: "GET", headers: GITHUB_HEADERS, timeout }).result()
  const filesResp = get(`https://api.github.com/repos/${ev.repo}/pulls/${ev.number}/files?per_page=100`)
  if (!ok(filesResp)) throw new Error(`GitHub files request failed: HTTP ${filesResp.statusCode}`)
  const files = JSON.parse(text(filesResp)) as GithubFile[]

  // Optional: the judgment still works without the original README.
  let baseReadme: string | null = null
  try {
    const raw = get(`https://raw.githubusercontent.com/${ev.repo}/${ev.baseSha}/README.md`)
    if (ok(raw)) baseReadme = text(raw)
  } catch (_) {
    baseReadme = null
  }
  return {
    patches: files.filter((f) => f.patch).slice(0, 5).map((f) => ({ filename: f.filename, patch: f.patch as string })),
    baseReadme,
  }
}

// ---------------------------------------------------------------------------------------------
// Step 2a: judgment by Gemini
// ---------------------------------------------------------------------------------------------

const askGemini = (apiKey: string, model: string, timeout: string, criteria: string[], ev: Evidence) =>
  (nodeRuntime: NodeRuntime<Config>): string => {
    const ctx = fetchContext(nodeRuntime, ev, timeout)
    const body = {
      systemInstruction: { parts: [{ text: GEMINI_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: buildPrompt(criteria, ev, ctx) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA,
        // Keep reasoning short so the answer fits the 10s HTTP limit (3.x models use thinkingLevel).
        thinkingConfig: { thinkingLevel: "minimal" },
      },
    }
    const resp = new HTTPClient()
      .sendRequest(nodeRuntime, {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: Buffer.from(new TextEncoder().encode(JSON.stringify(body))).toString("base64"),
        timeout,
        // POST: let the first node's answer be shared with the others so every node judges identically.
        cacheSettings: { store: true, maxAge: "120s" },
      })
      .result()
    if (!ok(resp)) throw new Error(`Gemini request failed: HTTP ${resp.statusCode}`)
    // Only the aligned verdicts go to consensus, not response metadata that may vary per call.
    return JSON.stringify(parseGemini(text(resp), criteria))
  }

// ---------------------------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------------------------

const REPORT_PARAMS = parseAbiParameters("uint256 jobId, uint256 index, uint8 verdict, bytes32 reasonHash, bytes32 evidenceHash")

export const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const cfg = runtime.config
  const req = decodeJson(payload.input) as ReviewRequest
  const ids = validateRequest(req)
  runtime.log(`Foreman review: job ${ids.jobId} milestone ${ids.index}, ${req.criteria.length} criteria, deliverable ${req.deliverableUrl}`)

  // 1. Evidence
  const evidence = JSON.parse(
    runtime.runInNodeMode(fetchEvidence(req.deliverableUrl, cfg.httpTimeout), consensusIdenticalAggregation<string>())().result(),
  ) as Evidence
  runtime.log(
    `Evidence: ${evidence.repo}#${evidence.number} "${evidence.title}" state=${evidence.state} merged=${evidence.merged} ` +
      `files=${evidence.files.map((f) => `${f.filename}(${f.status})`).join(",")} +${evidence.additions}/-${evidence.deletions}`,
  )

  // 2. Judgment: deterministic checks always run (hard evidence); Gemini adds the reading comprehension.
  const deterministic = deterministicJudge(req.criteria, evidence)
  let method: Method = "deterministic"
  let model: string | null = null
  let results: CriterionResult[] = deterministic
  let note: string | null = null

  let apiKey: string | null = null
  try {
    // Secrets are read inside the handler (trigger-subscription time blocks them).
    apiKey = runtime.getSecret({ id: GEMINI_SECRET_ID }).result().value
  } catch (_) {
    note = `${GEMINI_SECRET_ID} secret not available; used deterministic checks`
  }
  if (!apiKey && !note) note = `${GEMINI_SECRET_ID} secret is empty; used deterministic checks`
  if (apiKey) {
    try {
      const raw = runtime
        .runInNodeMode(
          askGemini(apiKey, cfg.geminiModel, cfg.httpTimeout, req.criteria, evidence),
          consensusIdenticalAggregation<string>(),
        )()
        .result()
      results = mergeJudgments(JSON.parse(raw) as CriterionResult[], deterministic)
      method = "gemini"
      model = cfg.geminiModel
    } catch (e) {
      note = `Gemini call failed (${e instanceof Error ? e.message : String(e)}); used deterministic checks`
    }
  }
  if (note) runtime.log(`Judgment fallback: ${note}`)
  results.forEach((r, i) => runtime.log(`Criterion ${i + 1}: met=${r.met} (${method}) ${r.reason}`))

  // 3. Guardrails -> verdict
  const decision = decide(results, Number(req.revisionsUsed), evidence)
  decision.guardrails.forEach((g) => runtime.log(`Guardrail: ${g}`))

  // 4. Decision record and hashes
  const { record, reasonHash, evidenceHash } = buildRecord({ ids, req, method, model, results, decision, evidence, note })
  runtime.log(`Decision record: ${canonicalJSON(record)}`)
  runtime.log(`Verdict ${decision.verdict} (${record.verdictName}) via ${method}`)
  runtime.log(`reasonHash=${reasonHash}`)
  runtime.log(`evidenceHash=${evidenceHash}`)

  // 5. Signed report -> receiver on Arc (a real transaction only when simulated with --broadcast)
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName })
  if (!network) throw new Error(`Unknown chain selector name: ${cfg.chainSelectorName}`)
  const evmClient = new EVMClient(network.chainSelector.selector)

  const reportData = encodeAbiParameters(REPORT_PARAMS, [ids.jobId, ids.index, decision.verdict, reasonHash, evidenceHash])
  const report = runtime
    .report({ encodedPayload: hexToBase64(reportData), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result()
  const write = evmClient
    .writeReport(runtime, { receiver: cfg.receiverAddress, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result()
  if (write.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport to ${cfg.receiverAddress} failed: txStatus=${write.txStatus} ${write.errorMessage ?? ""}`)
  }
  const txHash = bytesToHex(write.txHash || new Uint8Array(32))
  runtime.log(`Report written to ${cfg.receiverAddress} on ${cfg.chainSelectorName}: tx ${txHash}`)

  return canonicalJSON({
    jobId: ids.jobId,
    index: ids.index,
    verdict: decision.verdict,
    method,
    reasonHash,
    evidenceHash,
    receiver: cfg.receiverAddress,
    txHash,
  })
}

export const initWorkflow = (_config: Config) => {
  // Empty trigger config is fine for simulation; a deployed workflow lists authorizedKeys here.
  return [handler(new HTTPCapability().trigger({}), onHttpTrigger)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
