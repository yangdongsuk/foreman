# Foreman

**An AI agent that runs freelance contracts for a small business, inside spending limits a smart contract enforces.** USDC on Arc.

**Live dashboard:** https://yangdongsuk.github.io/foreman/ · **Demo video:** [YouTube (2:35)](https://youtu.be/VLXhugGEiH0) · [mp4](https://github.com/yangdongsuk/foreman/releases/download/v0.1.0-demo/foreman-demo.mp4) · **Contracts:** see [Deployment](#deployment-arc-mainnet)

Foreman drafts the scope and milestones from a plain-English brief, escrows the money, reviews every delivery with paid tools, and then approves it, sends it back with concrete feedback, or hands it to the owner. It can only release money that the owner already escrowed, only up to an auto-approve cap and a daily cap, and only for work the freelancer actually submitted. Anything bigger needs the owner's co-signature, and a kill switch stops it instantly. Every decision comes with its reasoning, and the hash of that reasoning is written on chain.

## The problem

Small businesses already pay contractors per milestone, and an AI agent could do most of the contract management: write the scope, check deliveries, chase revisions, release payments. What stops them is the wallet. Today an agent's budget is a sentence in its prompt, so one prompt injection, one hallucinated "looks good", or one leaked key can drain whatever it holds.

Foreman moves the budget out of the prompt and into a contract:

| Limit | Enforced by | What it stops |
| --- | --- | --- |
| The agent holds no job money. Escrow does, and the policy contract is the escrow's only client | `ForemanPolicy` + Stagepay | A compromised agent key draining funds |
| Money moves only for a milestone the freelancer **submitted** | `ForemanPolicy` (`NotSubmitted`) | Paying for work that was never delivered |
| Per-milestone **auto-approve cap** | `ForemanPolicy` (`OverAutoApproveCap`) | One bad call paying out a large milestone |
| **Daily release cap** across all jobs | `ForemanPolicy` (`OverDailyCap`) | Fast repeated mistakes |
| Above the cap → `agentEscalate`, then the owner's `ownerCosign` | `ForemanPolicy` (`NotEscalated`) | Big payments without a human |
| **Kill switch** `setPaused(true)` stops every agent action; owner functions keep working | `ForemanPolicy` (`IsPaused`) | A misbehaving agent, instantly |
| Tool spending capped by a prepaid channel; the agent's key there is an **unfunded session key** | Tollgate | Runaway tool bills; a leaked key costs at most the channel balance |
| At most 3 revision requests per milestone; if nobody responds, the freelancer can claim after the review window | Stagepay | The agent (or owner) holding finished work hostage |

The agent's code also checks these limits before it acts, so it escalates instead of sending a transaction that would revert. But the contract is the authority: the prompt is never trusted with money.

## How it works

```
 owner ── brief ──► Foreman plans scope, milestones, acceptance criteria ──► plan hashed (termsHash), owner signs off
 owner ── fundJob ─► ForemanPolicy ── createJob ──► Stagepay escrow (policy = client, freelancer = payee)

 freelancer ── submit(milestone, "PR / URL") ──► Stagepay
                                                   │
 Foreman review loop (up to 6 steps) ◄─────────────┘
   ├─ picks a tool from a priced catalog ── HTTP + Tollgate voucher (session key) ──► tool server
   │      http-check 0.001 · github 0.002 · rubric (LLM judge) 0.005 USDC        (402 tells it the price)
   ├─ gathers evidence, decides: approve | request_revision | escalate
   ├─ guardrails in code override the model (cap, daily allowance, revisions used, unmet criteria, window)
   └─ decision record ── keccak256 ──► reasonHash
                                          │
 ForemanPolicy.agentApprove / agentRequestRevision / agentEscalate(…, reasonHash) ──► Stagepay pays or reopens
 owner ── ownerCosign ──► escalated milestone paid           owner ── setPaused(true) ──► agent stopped
```

### The agent loop

`agent/review.mjs` handles one submitted milestone end to end:

1. **Load the plan and verify it.** The plan is found by the job's on-chain `termsHash`; if the file's hash doesn't match, the agent refuses to review.
2. **Gather evidence with paid tools.** Each turn the model sees the acceptance criteria verbatim, the freelancer's note, the evidence so far, the tool catalog with prices, its remaining tool budget and the on-chain limits. It either calls one tool or decides. Every call is paid with a Tollgate voucher; the tool server answers `402 Payment Required` with its terms when a voucher is missing.
3. **Decide.** `approve` only if every criterion is met *on evidence returned by tools* (the freelancer's note is a claim, not proof). `request_revision` comes with concrete feedback, sent on chain as the revision note. `escalate` when the evidence is inconclusive or the call is subjective.
4. **Guardrails in code have the last word.** An approval above the cap or today's allowance becomes an escalation. A fourth revision request becomes an escalation. An approval with an unmet criterion becomes a revision request. A review window about to lapse becomes an escalation. A failed model call becomes an escalation. Each override is written into the record.
5. **Record, hash, act.** The decision record (verdict, rationale, per-criterion evidence, guardrail overrides, every tool call with its receipt, model, plan hash) is canonical JSON. Its keccak256 goes on chain as `reasonHash` with the transaction, and the record is published to `web/data/decisions.json`.

### A decision log you can verify

The dashboard reads `AgentDecision` events from Arc and recomputes `keccak256(canonicalJSON(record))` in your browser. If anyone edits the published reasoning after the fact, the check turns red. Canonical JSON = sorted keys, no whitespace, bigints as strings (`agent/canonical.mjs`, mirrored in `web/app.js`).

### Pay-per-call tools (Tollgate)

The owner opens a Tollgate channel to the tool provider and names a fresh **session key** as the voucher signer. The key holds nothing and never pays gas. Each call carries a cumulative EIP-712 voucher in the `x-tollgate-voucher` header. The provider verifies it off chain and redeems the latest voucher on chain in one transaction whenever that's worth the gas. The agent sees its remaining tool budget every step and stops calling tools when it can't afford the cheapest one.

## Circle stack on Arc

- **USDC is the gas and the settlement asset.** The agent's key only needs a few cents of USDC for gas; the session key needs nothing. No second token anywhere.
- **USDC and EURC escrow.** `foreman fund --token EURC` escrows a euro contract with the same rules.
- **Sub-second finality.** "Approved" means paid, not "wait for confirmations".
- **Circle's ERC-20 interface for USDC** (`0x3600…0000`, 6 decimals) is used for all accounting; the 18-decimal native balance is only gas.

## Chainlink CRE: the review as a verifiable workflow

The review step also exists as a [Chainlink CRE](https://docs.chain.link/cre) workflow (`cre/foreman-review`, TypeScript). It is the orchestration layer around the review: it takes a submitted milestone, collects evidence, asks a model to judge each acceptance criterion, applies Foreman's guardrails, and writes the result to Arc.

1. **Trigger.** An HTTP trigger receives `{ jobId, index, deliverableUrl, criteria, amountUnits, revisionsUsed }`. `foreman attest` builds it from the signed-off plan and the on-chain milestone.
2. **Evidence.** The workflow reads the GitHub pull request (state, files changed, the base README) and the nodes reach consensus on it.
3. **Judgment.** One Gemini call (secret `GEMINI_API_KEY`) marks each criterion met or unmet with a reason. Deterministic checks run alongside and override the model when they prove a criterion false. If the key is missing or the call fails, the workflow falls back to the deterministic checks alone, leaves what needs a reader as unverified, escalates, and records that in the decision. It never crashes and never approves on a guess.
4. **Guardrails.** Any unmet criterion gives a revision request, spent revisions or an unverified criterion give an escalation, and only all-met gives an approval.
5. **Report.** The decision record is canonicalised and hashed (the same rule as `agent/canonical.mjs`, checked byte for byte in a test). The workflow asks the DON for a signed report of `(jobId, index, verdict, reasonHash, evidenceHash)` and writes it through Chainlink's forwarder to `ForemanReviewReceiver`, which only accepts calls from the forwarder and emits `ReviewAttested`.

**Why CRE.** Today one agent process makes the call and we ask you to trust the log. In CRE every node fetches the evidence and runs the judgment itself, the results must reach consensus, and the DON signs the report that lands on chain. The `reasonHash` that anyone can recompute from the published record is then attested by a network rather than by our server alone.

**What is real, and what is not.** This is a CRE *simulation with a real broadcast*: `cre workflow simulate --broadcast` runs the workflow locally and sends the report as a real transaction through Chainlink's `MockKeystoneForwarder` on Arc Testnet (chain 5042002). It is not a deployed workflow running on a DON: deploy access is not enabled on our CRE account yet, and the mock forwarder does not check DON signatures. The mainnet escrow flow (Stagepay, `ForemanPolicy`, the review loop above) is unchanged and does not depend on CRE.

| | |
| --- | --- |
| Receiver (Arc Testnet) | [`0xD069469B0828bACB492a18614f93159D255b0E6d`](https://testnet.arcscan.app/address/0xD069469B0828bACB492a18614f93159D255b0E6d), verified on [Sourcify](https://repo.sourcify.dev/5042002/0xD069469B0828bACB492a18614f93159D255b0E6d) |
| Forwarder | MockKeystoneForwarder `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| Broadcast tx (job 2, milestone 1, approve via Gemini) | [`0x6b799f0e1ec4288b207c69323c309971c5e76bf3252573e2ef33a0b59844b3c3`](https://testnet.arcscan.app/tx/0x6b799f0e1ec4288b207c69323c309971c5e76bf3252573e2ef33a0b59844b3c3) |
| Earlier broadcast (Gemini timed out, deterministic fallback, escalate) | [`0x5975f0c752587a533f3559b3920e7f3e71e1a19268efdc99d214f66ace45ff8a`](https://testnet.arcscan.app/tx/0x5975f0c752587a533f3559b3920e7f3e71e1a19268efdc99d214f66ace45ff8a) |

The receiver keeps the latest attestation per milestone and counts every report (three so far, from three runs), so the last transaction is the stored one and the earlier events stay in the chain's logs. The receiver does not yet check the workflow id or owner in the report metadata; that is a step for a production deployment. The pilot job itself was settled on mainnet earlier, so the attestation is a second, independent opinion on the same pull request, not a payment trigger.

Run it (needs the [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation), Bun, a funded Arc Testnet key in `cre/.env`; details in [`cre/README.md`](cre/README.md)):

```bash
node agent/foreman.mjs attest --job 2 --index 0     # builds the payload, simulates with --broadcast, prints the tx
```

A recorded run is in [`demo/transcripts/11-cre-attest.log`](demo/transcripts/11-cre-attest.log), and each run is appended to `log/cre-attestations.jsonl`.

## Deployment (Arc mainnet)

| Contract | Address |
| --- | --- |
| ForemanPolicy (new) | [`0x2065a64a410E0610ebD654b4eC4ADE142e9A68E2`](https://explorer.arc.io/address/0x2065a64a410E0610ebD654b4eC4ADE142e9A68E2) ([deploy tx](https://explorer.arc.io/tx/0xc3bbbd93f49285d01922c21d59e3978f73e75a3ebdf5833eb0a8070a028c0750)) · [Sourcify](https://repo.sourcify.dev/5042/0x2065a64a410E0610ebD654b4eC4ADE142e9A68E2) · caps: 0.10 USDC per milestone, 0.15 USDC per day |
| Stagepay (milestone escrow) | [`0x0A87039a127b600cF9B85d4C33d97c08054e15E6`](https://explorer.arc.io/address/0x0A87039a127b600cF9B85d4C33d97c08054e15E6) · [Sourcify](https://repo.sourcify.dev/5042/0x0A87039a127b600cF9B85d4C33d97c08054e15E6) |
| Tollgate (pay-per-call channels) | [`0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F`](https://explorer.arc.io/address/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) · [Sourcify](https://repo.sourcify.dev/5042/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) |

### The first job on mainnet

A pilot job, run on 2026-10-18 (KST) with our own test freelancer account. Every step is an Arc mainnet transaction:

| Step | Who | Proof |
| --- | --- | --- |
| Brief → plan with acceptance criteria, hashed (`termsHash 0x92e83f08…`) | agent | [plan file](plans/0x92e83f085e62697eb5839189f3a50da70c3d68be99dc6fa0903ede42846cef14.json) |
| Tool channel opened with 0.04 USDC; an unfunded session key signs the vouchers | owner | [tx](https://explorer.arc.io/tx/0xfb41a270f73ece1411fb5265538dfa88204e5b1900b2cbc930a179162ef0eb6b) |
| Job #2 funded through the policy: 0.05 + 0.15 USDC in escrow | owner | [tx](https://explorer.arc.io/tx/0xd7f24735ba2d3cd3b8946a1f04206045fb5dc32c4828606817476e1c266fe4cc) |
| Milestone 1 submitted: [PR #1](https://github.com/yangdongsuk/foreman/pull/1), a Korean README that left out the limits table | freelancer | [tx](https://explorer.arc.io/tx/0x5d22b5580bc5454d8a95999bfe2b575037789a8f4157f988869701e3cbebc441) |
| Agent paid for 2 tool calls (0.003 USDC), found the missing table and **requested a revision** with a concrete note | agent | [tx](https://explorer.arc.io/tx/0xcc1b8fd53b70fbfb5ede79378bc7a662d7e22138b0a00cef79a75729a2c74f31) |
| Milestone 1 resubmitted with the table | freelancer | [tx](https://explorer.arc.io/tx/0x0d2de46370a8c53051b8f32e4ea5ef27d1f0e205b3ff180a215970b4174696a0) |
| Agent compared both files in full (3 tool calls, 0.004 USDC) and **approved**: 0.05 USDC paid | agent | [tx](https://explorer.arc.io/tx/0x68f3a00f44fbbe143160ea4f8bb39883737b9f36983d87e4da8bff80fc590043) |
| Milestone 2 submitted: the [Korean landing page](https://yangdongsuk.github.io/foreman/ko.html) | freelancer | [tx](https://explorer.arc.io/tx/0xc67f3bd315ef7de3458a8727bea4cee0b8c6a978196bb45da02059eeff910a52) |
| Agent **escalated**: 0.15 USDC is above the 0.10 cap, and it said it could not verify the link targets | agent | [tx](https://explorer.arc.io/tx/0x8bc7b7ae67d3a88829135eb2fc35d91b5e2f13a0cff011cc21d544290eec9ba0) |
| Owner checked the flagged links and **co-signed**: 0.15 USDC paid | owner | [tx](https://explorer.arc.io/tx/0x0ccefae5e7fb85d5bdaf58ab0da77ae27e4ff583c24d1e2ef69c757a73233c8e) |
| Kill switch on; an agent call reverts with `IsPaused`; kill switch off | owner | [pause](https://explorer.arc.io/tx/0xe33eb5dfe24f7a6085dc4e35fcfda5e3dce9c0dca60ec1896809e819e5f10151) · [resume](https://explorer.arc.io/tx/0x1c4dd464d906950b9320ae68bfde31b699f4f77daf68f4593bc1dc545b2682ef) |
| Tool provider redeemed 0.012 USDC of vouchers in 3 transactions | provider | [1](https://explorer.arc.io/tx/0x68d6beecde5856388705465ff5cf76510fdfdda35612e2eed17f05cfba975ad6) · [2](https://explorer.arc.io/tx/0x3b7e07d82914490ab3330a8b5cb23643c9b320e797f0013a76aad71544622364) · [3](https://explorer.arc.io/tx/0x2e2cdda8daf962632f9e45b6c3fffbb578ae09402b6f8a120a799c3df1e53853) |

The decision records behind the three agent transactions are in [`web/data/decisions.json`](web/data/decisions.json) (the dashboard re-checks their hashes), and the terminal output of every step is in [`demo/transcripts/`](demo/transcripts/).

**What the run taught us** (fixed the same night): the first review could see only 3,000 characters of the file, so raw text deliverables are now returned whole; the landing-page review could not see link targets, so `http-check` now returns every link with its resolved URL; and the repository README lookup no longer mis-parses GitHub's raw media type.

## Run it

Requirements: Node 24, Foundry, and either `ANTHROPIC_API_KEY` or a logged-in Claude Code CLI (`claude`) for the model.

```bash
npm install
forge test                      # policy contract tests, including a fuzz test of the daily cap
bash scripts/local-e2e.sh       # the whole workflow on a local anvil node with real model calls
```

On Arc mainnet (keys come from the environment; see `SPEC.md` for the roles):

```bash
cd foreman && npm install
forge create contracts/src/ForemanPolicy.sol:ForemanPolicy --rpc-url https://rpc.mainnet.arc.io \
  --private-key $OWNER_KEY --broadcast --gas-price 40gwei --priority-gas-price 1gwei \
  --constructor-args 0x0A87039a127b600cF9B85d4C33d97c08054e15E6 $AGENT_ADDRESS 100000 150000
export FOREMAN_POLICY=0x... POLICY_DEPLOY_BLOCK=...
DEPOSIT_USDC=0.04 node scripts/open-channel.mjs          # prints TOLLGATE_CHANNEL=0x...
node tools/server.mjs &                                   # pay-per-call tools on :8790
node agent/foreman.mjs plan --brief "..." --budget 0.2 --yes
node agent/foreman.mjs fund --plan <termsHash> --freelancer <address>
node agent/foreman.mjs watch --job <id>                   # reviews submissions as they arrive
node agent/foreman.mjs cosign --job <id> --index <i>      # owner, for escalations
node agent/foreman.mjs pause                              # owner kill switch (resume to undo)
```

## Repository

| Path | What |
| --- | --- |
| `contracts/src/ForemanPolicy.sol` | The agent's on-chain mandate (caps, co-sign, kill switch). Tests in `contracts/test/` |
| `agent/` | The Foreman agent and CLI: planning, the review loop, guardrails, decision records |
| `cre/foreman-review/` | The Chainlink CRE review workflow (TypeScript) and its sample payloads. `contracts/src/cre/` holds `ForemanReviewReceiver`; `agent/attest.mjs` drives it |
| `tools/` | Pay-per-call tool server guarded by Tollgate (`http-check`, `github`, `rubric`) |
| `web/` | Static dashboard that reads Arc and verifies the decision log |
| `vendor/tollgate.mjs`, `contracts/src/vendor/` | Tollgate SDK and the two contracts Foreman builds on, unchanged |

## Status and honesty notes

- Built during the Tameion Agents Hackathon (see the commit history). Stagepay and Tollgate were written and deployed in the week before the event and were not changed during it.
- Traction so far is a pilot: one job with two milestones, three agent decisions and one owner co-sign, 0.20 USDC escrowed and paid out, and 0.012 USDC of tool calls paid by voucher, all with our own owner and freelancer accounts. There are no outside customers yet.
- The Chainlink CRE integration is a simulation with a real broadcast through the mock forwarder on Arc Testnet; CRE deploy access is not enabled yet, so it has not run on a DON. Mainnet escrow does not use it.
- Known limits: one owner per policy; the model runs through the owner's own Anthropic key or Claude Code login; the tool server is a single process; reasoning text is public by design.

MIT license.
