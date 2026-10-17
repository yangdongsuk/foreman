# foreman-review (Chainlink CRE workflow)

Orchestration layer for Foreman's milestone review: GitHub (evidence) + Gemini (judgment) -> guardrails ->
hashed decision record -> signed report written to a receiver contract on Arc.

| Step | What | Where |
| --- | --- | --- |
| trigger | HTTP trigger, input `{ jobId, index, deliverableUrl, criteria[], amountUnits, revisionsUsed }` | `main.ts` |
| 1 evidence | GitHub REST (PR, files, base README); DON consensus on the result | `fetchEvidence` |
| 2 judgment | Gemini via secret `GEMINI_API_KEY` (one shared call, `cacheSettings`); else deterministic checks, criteria needing a reader stay `unverified` | `askGemini`, `deterministicJudge` |
| 3 guardrails | unmet -> 1 (revision), revisions spent -> 2, unverified -> 2, all met -> 0 | `decide` in `logic.ts` |
| 4 record | canonical JSON (same rule as `agent/canonical.mjs`), `reasonHash`, `evidenceHash` = keccak256 | `buildRecord` |
| 5 report | `runtime.report` of `(uint256 jobId, uint256 index, uint8 verdict, bytes32 reasonHash, bytes32 evidenceHash)` -> `evmClient.writeReport` to `receiverAddress` on `arc-testnet` | `onHttpTrigger` |

The escrow cap is enforced elsewhere (ForemanPolicy on Arc mainnet); this workflow attests the review.

## Run

From `cre/` (the project root), under a pseudo-TTY:

```bash
cp .env.example .env            # set CRE_ETH_PRIVATE_KEY (testnet only) and optionally GEMINI_API_KEY
script -q /dev/null cre workflow simulate foreman-review --non-interactive --trigger-index 0 \
  --http-payload ./foreman-review/payloads/pilot-pr1.json --target staging-settings < /dev/null
# add --broadcast to send the report transaction through the MockKeystoneForwarder
```

`receiverAddress` in `config.staging.json` is the deployed `ForemanReviewReceiver` on Arc Testnet. See `../README.md` for setup.
The simulator requires the env var named in `secrets.yaml` to exist; an empty `GEMINI_API_KEY=` is fine and
makes the workflow use deterministic checks and say so in the record (`method`, `note`).

Payloads: `pilot-pr1.json` (the real pilot, job 2 milestone 1), `negative-wrong-file.json` (expects a revision).

## Test

```bash
bun install && bun test && bun run typecheck
```

## Notes

- A node's consensus observation is capped at 25 KB in simulation, so only small values (evidence, verdicts) go
  through consensus; the large diff and README text is fetched inside the Gemini step.
- Unauthenticated GitHub API calls are limited to 60/hour per IP; fine for simulation, add a token secret for a deployed DON.
