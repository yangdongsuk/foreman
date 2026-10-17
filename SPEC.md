# Foreman — build spec (internal, for the builders)

Foreman is an AI agent that runs freelance contracts for a small business **inside spending limits that a
smart contract enforces**, on Circle's Arc chain (USDC is the gas token). It reuses two contracts already live on
Arc mainnet:

- **Stagepay** `0x0A87039a127b600cF9B85d4C33d97c08054e15E6` — milestone escrow (source: `contracts/src/vendor/Stagepay.sol`).
- **Tollgate** `0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F` — prepaid USDC payment channels for pay-per-call APIs
  (source: `contracts/src/vendor/Tollgate.sol`, JS SDK: `vendor/tollgate.mjs` with `Meter` (payer) and `Gate` (provider)).

New in this repo: `ForemanPolicy` (the on-chain mandate), the agent, a pay-per-call tool server, a dashboard.

## The story the demo tells (one end-to-end workflow)

1. Owner writes a brief in plain English. The agent drafts scope, milestones, acceptance criteria, amounts,
   deadlines and its reasoning. The plan is hashed (`termsHash`) and the owner signs off.
2. Owner funds the job through `ForemanPolicy.fundJob` — the policy contract becomes the Stagepay *client*.
   The agent never holds job money; escrow does.
3. Freelancer submits a milestone on Stagepay with a note containing the deliverable URL (GitHub PR/repo/site).
4. The agent reviews it in a loop: it picks tools from a priced catalog, pays each call with a Tollgate voucher
   signed by an **unfunded session key** (max spend = channel balance), gathers evidence, and decides:
   - `approve` → `ForemanPolicy.agentApprove` (contract checks: not paused, amount ≤ autoApproveCap, daily cap),
   - `request_revision` → `agentRequestRevision` with concrete feedback (Stagepay caps revisions at 3),
   - `escalate` → `agentEscalate`; the owner co-signs with `ownerCosign` (needed for anything above the cap).
5. Every decision is a JSON record (rationale, per-criterion verdicts, tool receipts, evidence); its keccak256 is
   written on chain as `reasonHash`. The dashboard recomputes the hash to prove the log wasn't edited.
6. Owner kill switch: `setPaused(true)` stops all agent actions instantly.

Limits are enforced by the contract, not the prompt. The agent's code ALSO pre-checks them so it escalates
instead of sending a transaction that would revert.

## Chain facts

- Arc mainnet chainId 5042, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`.
- USDC ERC-20 interface `0x3600000000000000000000000000000000000000`, **6 decimals**. Native balance is the same
  USDC with 18 decimals (gas). EURC `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`.
- Fees: always pass `FEES` from `lib/config.mjs` (maxFeePerGas 40 gwei) or Arc silently drops the tx.
- Shared JS config + ABIs: `lib/config.mjs` (`chain`, `ADDR`, `FEES`, `POLICY_ABI`, `STAGEPAY_ABI`, `ERC20_ABI`,
  `fmtUSDC`, `toUnits`, `txUrl`, `ACTION`). Every env var override (RPC_URL, CHAIN_ID, STAGEPAY, TOLLGATE, USDC,
  FOREMAN_POLICY) lets the same code run on a local anvil node.
- JS is plain Node 24 ESM (`.mjs`), only dependency `viem` (already in package.json). No TypeScript, no build step.

## Keys (never commit; loaded from env)

`OWNER_KEY` (the business), `AGENT_KEY` (calls ForemanPolicy agent functions; holds only gas),
`SESSION_KEY` (signs Tollgate vouchers; holds nothing), `PROVIDER_KEY` (tool server; redeems vouchers),
`FREELANCER_KEY` (demo freelancer). Scripts read them from the environment (the operator sources
`~/.config/foreman/keys.env`).

## 1. contracts/ (Foundry, root `foundry.toml` points src=contracts/src, test=contracts/test, script=contracts/script)

`contracts/src/ForemanPolicy.sol`, Solidity ^0.8.24, no external deps (copy the minimal IERC20 + IStagepay
interfaces inline). The ABI MUST match `POLICY_ABI` in `lib/config.mjs` exactly:

- `constructor(address stagepay, address agent, uint128 autoApproveCap, uint128 dailyCap)`; `owner = msg.sender`.
- State: `owner`, `agent`, `stagepay` (immutable), `autoApproveCap`, `dailyCap`, `paused`,
  `managed(jobId)`, `escalated(jobId,index)` (nested mapping getter), `jobAt(i)` + `jobCount()` (array of
  managed jobIds), `releasedOnDay[day]` where `day = block.timestamp / 1 days`.
- `fundJob(freelancer, token, amounts, deadlines, reviewPeriod, termsHash) onlyOwner returns (jobId)`: pull
  `sum(amounts)` from owner via transferFrom (check balance delta), approve Stagepay for exactly that sum, call
  `createJob` (policy is the client), mark managed, push jobId, emit `JobFunded`.
- Agent functions (onlyAgent, whenNotPaused, onlyManaged, milestone status must be Submitted (=2; Stagepay's enum is None, Funded, Submitted, Released, Refunded, Split) else
  `NotSubmitted`):
  - `agentApprove(jobId, index, reasonHash)`: amount = milestone.amount; `amount > autoApproveCap` →
    `OverAutoApproveCap`; `releasedOnDay[today] + amount > dailyCap` → `OverDailyCap`; record, call
    `stagepay.approve`, emit `AgentDecision(jobId, index, 0, amount, reasonHash)`.
  - `agentRequestRevision(jobId, index, note, reasonHash)`: call `stagepay.requestRevision(jobId, index, note)`,
    emit `AgentDecision(..., 1, amount, reasonHash)`.
  - `agentEscalate(jobId, index, reasonHash)`: set `escalated[jobId][index] = true`, emit
    `Escalated(jobId, index, amount, reasonHash)` and `AgentDecision(..., 2, amount, reasonHash)`.
- Owner functions (onlyOwner, work even when paused): `ownerCosign` (requires escalated → `NotEscalated`;
  clears flag; `stagepay.approve`; emit `OwnerCosigned`), `ownerApprove`, `ownerRequestRevision`,
  `ownerCancelExpired`, `ownerProposeSplit`, `ownerAcceptSplit` (straight pass-through to Stagepay),
  `withdraw(token, to, amount)` (refunds land in the policy because it is the client), `setLimits` (emit
  `LimitsSet`), `setAgent` (emit `AgentSet`), `setPaused` (emit `PausedSet`).
- Views: `spentToday()` = releasedOnDay[today]; `remainingToday()` = dailyCap - spentToday (floor 0).
- Errors exactly as in POLICY_ABI. Constructor reverts `InvalidParams` on zero stagepay/agent.
- Use a simple reentrancy guard on functions that call Stagepay.

`contracts/test/ForemanPolicy.t.sol` (forge-std is available at `lib/forge-std`, remapping
`forge-std/=lib/forge-std/src/`). Use the real vendored Stagepay + a 6-decimal mock USDC. Cover: fund happy
path; agent approve within cap pays freelancer; over cap reverts; escalate → owner cosign pays; cosign without
escalation reverts; daily cap across two milestones; daily cap resets next day (vm.warp); pause blocks agent
but not owner; non-agent/non-owner reverts; agent revision works and Stagepay's 3-revision cap holds;
cancelExpired refund → withdraw; events carry reasonHash; a fuzz test that the agent can never release more
than dailyCap in one day.

`contracts/script/Deploy.s.sol`: reads env `AGENT_ADDRESS`, `AUTO_APPROVE_CAP` (units), `DAILY_CAP` (units),
optional `STAGEPAY` (default the mainnet address); deploys with `vm.startBroadcast()`; logs the address.

## 2. tools/server.mjs — pay-per-call tool server guarded by Tollgate

Node `http` server (no frameworks). Env: `PROVIDER_KEY`, `PORT` (default 8790), plus lib/config overrides.
Uses `Gate` from `vendor/tollgate.mjs` exactly like `~/project/tollgate/examples/paid-api.mjs` (read it).
CORS on every response (`access-control-allow-headers: x-tollgate-voucher, content-type`).

- `GET /tools` (free) → `{ provider, contract, chainId, token, tools: [{ name, method, path, price, description, params }] }`.
- `GET /tools/http-check?url=` — price `1000` (0.001 USDC). Fetch with 10s timeout, follow redirects. Return
  `{ url, finalUrl, status, ok, ms, contentType, bytes, title, h1, metaDescription, linkCount, textSample }`
  (textSample = visible text, max 3000 chars, tags stripped).
- `GET /tools/github?url=` — price `2000`. PR URL → GitHub REST: title, body (≤2000 chars), state, merged,
  additions, deletions, changed_files, commits, files (filename/status/additions/deletions, ≤50), a unified diff
  excerpt (≤6000 chars via the `.diff` media type), combined status/check-runs summary. Repo URL → description,
  stars, default branch, latest commit (sha/message/date), README excerpt (≤3000 chars). Commit URL → message,
  stats, files. Use `GITHUB_TOKEN` env if present.
- `POST /tools/rubric` body `{ criteria: string[], deliverable: string, evidence: string }` — price `5000`.
  An LLM judge: call `agent/llm.mjs` `askJSON()` with a schema
  `{ verdicts: [{ criterion, met: boolean, confidence: number, rationale }], summary }`. If the LLM is
  unavailable, return a clearly labeled heuristic result (`method: "heuristic"`).
- Paid endpoints: `const r = await gate.check(req.headers['x-tollgate-voucher'], PRICE)`; on failure respond
  with `r.status` (402) and `{ error, payment: { scheme: 'tollgate', chainId, contract, provider, token, price, header } }`.
  On success include `receipt: { channelId, cumulative, price }` in the JSON.
- Redemption: keep the best voucher per channel (Gate does this); redeem on chain when owed − redeemed ≥
  `REDEEM_AT` (env, default 5000) and on `POST /admin/redeem` (only from 127.0.0.1) and on SIGINT/SIGTERM.
  Append every redemption to `log/redemptions.jsonl` as `{ ts, channelId, cumulative, tx }` and print the
  explorer URL.

## 3. agent/ — the Foreman agent (the heart of the project: "agentic sophistication" is 30% of judging)

Files:
- `agent/llm.mjs`: `export async function askJSON({ system, prompt, schema, model })`. If `ANTHROPIC_API_KEY` is
  set → Anthropic Messages API (fetch, model env `FOREMAN_MODEL`, default `claude-sonnet-5-5`; use a forced tool
  call whose input_schema is `schema`). Else → local Claude Code CLI:
  `claude -p <system+prompt> --output-format json --json-schema <schema> --model <FOREMAN_CLI_MODEL||'sonnet'>`
  run via `child_process.spawn` with cwd `/tmp`, env with every `CLAUDE_CODE*` and `CLAUDECODE` var removed,
  timeout 300s; parse stdout JSON and return `.structured_output`. Throw a clear error otherwise.
- `agent/chain.mjs`: viem public client + wallet clients for OWNER/AGENT/FREELANCER keys (`FEES` on every
  write, wait for receipt, throw on revert with the decoded custom error name). Helpers: `readJob(jobId)`,
  `readMilestones(jobId)`, `readPolicy()` (owner, agent, caps, paused, spentToday, remainingToday),
  `submittedNote(jobId, index)` (latest `MilestoneSubmitted` log for that milestone — chunked getLogs, 5,000
  blocks per request, starting from `POLICY_DEPLOY_BLOCK` env or the JobFunded block), `fundJob(plan)`,
  `agentApprove/agentRequestRevision/agentEscalate`, `ownerCosign`, `setPaused`, `freelancerSubmit`.
- `agent/tools-client.mjs`: discovers the catalog from `GET {TOOLS_URL}/tools`, pays each call with a Tollgate
  `Meter` (session key, `TOLLGATE_CHANNEL` env), persists the cumulative total in `state/meter.json` so restarts
  don't reuse amounts, reads the channel's on-chain deposit/redeemed to compute the remaining budget, and on
  a 402 re-reads terms once. Returns `{ result, receipt, priceUnits }`.
- `agent/plan.mjs`: brief → plan via `askJSON` with schema
  `{ title, summary, reasoning, milestones: [{ name, deliverable, acceptanceCriteria: string[], amountUSDC, deadlineDays }], reviewPeriodHours, risks: string[] }`.
  Then code checks: total ≤ `--budget`; flags each milestone whose amount > autoApproveCap as "owner co-sign
  required"; ≤ 20 milestones. Canonical JSON (sorted keys) → `termsHash = keccak256(toBytes(json))`; save
  `plans/<termsHash>.json` (include brief, plan, createdAt, model). Print a human summary.
- `agent/review.mjs` — the agentic review loop for one submitted milestone:
  1. Load the plan by the job's on-chain `termsHash` from `plans/` and verify the hash (refuse if mismatch).
  2. Get the submission note (deliverable URL + message).
  3. Up to `MAX_STEPS` (6) iterations: `askJSON` with { milestone + acceptance criteria, submission note,
     revisions used, evidence so far (tool outputs, truncated), tool catalog with prices, remaining tool budget,
     policy (autoApproveCap, remainingToday, paused) } → schema
     `{ thought, next: 'call_tool' | 'decide', tool: { name, args } | null, decision: { verdict: 'approve' | 'request_revision' | 'escalate', rationale, criteria: [{ criterion, met, evidence }], feedbackToFreelancer } | null }`.
     Execute tool calls (paid) and append results. Stop early if the budget can't cover the cheapest tool.
  4. Guardrails in code (each one recorded in the decision record as `guardrails: [...]`):
     approve but amount > autoApproveCap or > remainingToday → escalate; request_revision but revisions ≥ 3 →
     escalate; policy paused → abort (no tx); any criterion unmet → cannot approve (downgrade to
     request_revision); review window about to lapse (< 10 min) → escalate.
  5. Build the decision record `{ version: 1, jobId, index, amountUnits, verdict, rationale, criteria,
     feedbackToFreelancer, guardrails, steps: [{ thought, tool, args, receipt, resultDigest }], toolSpendUnits,
     model, planHash, submissionNote, decidedAt }`; `reasonHash = keccak256(canonicalJSON(record))`.
  6. Send the tx with the AGENT key (approve / request revision with `feedbackToFreelancer` as the note,
     max 500 chars / escalate), then write `{ record, reasonHash, tx, explorer }` to `log/decisions.jsonl` and
     regenerate `web/data/decisions.json` (array, newest first) — the dashboard reads it.
- `agent/foreman.mjs` — CLI (parse argv by hand):
  - `plan --brief "<text>" --budget <usdc> [--yes]`
  - `fund --plan <termsHash> --freelancer <addr> [--token USDC|EURC]` (OWNER key; approve then fundJob; prints jobId)
  - `review --job <id> [--index <i>]` (reviews every Submitted milestone that has no decision yet, or one)
  - `watch --job <id> [--interval 15]` (loop: review new submissions until all milestones settle)
  - `cosign --job <id> --index <i>` (OWNER), `pause` / `resume` (OWNER), `limits` (print policy state)
  - `submit --job <id> --index <i> --note "<text>"` (FREELANCER key; demo helper)
  - `status --job <id>` (milestones, decisions, tool spend)
  Output: concise, readable, color via ANSI, every tx printed with its explorer URL. These terminal runs are
  filmed for the demo video, so make them look good (headers, aligned columns, a short reasoning excerpt).
- `agent/canonical.mjs`: canonical JSON (sorted keys, no whitespace, bigint → string) shared by plan/review/web.

## 4. web/ — static dashboard (GitHub Pages; no build step)

`web/index.html`, `web/app.js` (ES module, `import { createPublicClient, http, keccak256, toBytes, parseAbi } from 'https://esm.sh/viem@2.56.8'`),
`web/style.css`, `web/config.js` (`POLICY`, `POLICY_DEPLOY_BLOCK`, `TOOLS_CHANNEL`, RPC, explorer, Stagepay,
Tollgate). Reads live from Arc mainnet:
- Policy card: owner, agent, autoApproveCap, dailyCap, spent today, paused (kill switch state, red if paused).
- Jobs: from `JobFunded` logs (chunked getLogs) → each job's milestones from Stagepay `getMilestones`, status chips.
- Decision timeline: merge `AgentDecision` / `Escalated` / `OwnerCosigned` logs with `data/decisions.json`
  records (match by jobId+index+reasonHash). Show verdict, rationale, criteria table, guardrails, tools used and
  their cost, tx link. Recompute `keccak256(canonicalJSON(record))` in the browser and show
  "✓ log matches on-chain hash" or "✗ mismatch".
- Tool spend: Tollgate channel (deposit / redeemed / available) for `TOOLS_CHANNEL`.
- Clean, professional, light+dark, mobile-friendly. Explorer links everywhere. Empty states explained.
- Must work when opened from `file://` too if possible (fetch of data/decisions.json may fail there: show a hint).

## 5. scripts/local-e2e.sh — full run on a local anvil node (integration test, no real money)

anvil `--chain-id 5042`; deploy MockUSDC, Stagepay, Tollgate, ForemanPolicy (forge create or a forge script);
mint USDC; owner opens a Tollgate channel to PROVIDER with SESSION as signer; start tools server; plan →
fund → freelancer submit (note pointing at a real public GitHub PR, e.g. https://github.com/yangdongsuk/stagepay/pull/1
or any public repo URL) → review (agent decides) → milestone 2 above cap → escalate → cosign; pause blocks the
agent. Print PASS/FAIL per step.

## Ground rules for builders

- Stay inside your directory; don't edit files owned by another builder (shared files: `lib/`, `vendor/`,
  `SPEC.md` are read-only for you — report needed changes instead).
- No real transactions on Arc mainnet, no network writes anywhere. Local anvil only.
- Don't commit or push; the integrator does that.
- Keep code readable: short comments that explain why, not what.
