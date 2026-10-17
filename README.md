# Foreman

**An AI agent that runs freelance contracts for a small business, inside spending limits a smart contract enforces.** USDC on Arc.

**Live dashboard:** https://yangdongsuk.github.io/foreman/ · **Demo video:** [VIDEO_LINK] · **Contracts:** see [Deployment](#deployment-arc-mainnet)

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

## Deployment (Arc mainnet)

| Contract | Address |
| --- | --- |
| ForemanPolicy (new) | [POLICY_ROW] |
| Stagepay (milestone escrow) | [`0x0A87039a127b600cF9B85d4C33d97c08054e15E6`](https://explorer.arc.io/address/0x0A87039a127b600cF9B85d4C33d97c08054e15E6) · [Sourcify](https://repo.sourcify.dev/5042/0x0A87039a127b600cF9B85d4C33d97c08054e15E6) |
| Tollgate (pay-per-call channels) | [`0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F`](https://explorer.arc.io/address/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) · [Sourcify](https://repo.sourcify.dev/5042/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) |

[MAINNET_RUN]

## Run it

Requirements: Node 24, Foundry, and either `ANTHROPIC_API_KEY` or a logged-in Claude Code CLI (`claude`) for the model.

```bash
npm install
forge test                      # policy contract tests, including a fuzz test of the daily cap
bash scripts/local-e2e.sh       # the whole workflow on a local anvil node with real model calls
```

On Arc mainnet (keys come from the environment; see `SPEC.md` for the roles):

```bash
[MAINNET_COMMANDS]
```

## Repository

| Path | What |
| --- | --- |
| `contracts/src/ForemanPolicy.sol` | The agent's on-chain mandate (caps, co-sign, kill switch). Tests in `contracts/test/` |
| `agent/` | The Foreman agent and CLI: planning, the review loop, guardrails, decision records |
| `tools/` | Pay-per-call tool server guarded by Tollgate (`http-check`, `github`, `rubric`) |
| `web/` | Static dashboard that reads Arc and verifies the decision log |
| `vendor/tollgate.mjs`, `contracts/src/vendor/` | Tollgate SDK and the two contracts Foreman builds on, unchanged |

## Status and honesty notes

- Built during the Tameion Agents Hackathon (see the commit history). Stagepay and Tollgate were written and deployed in the week before the event and were not changed during it.
- [TRACTION_NOTE]
- Known limits: one owner per policy; the model runs through the owner's own Anthropic key or Claude Code login; the tool server is a single process; reasoning text is public by design.

MIT license.
