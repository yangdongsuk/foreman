# Foreman on Chainlink CRE

The CRE project for Foreman: one workflow, `foreman-review`, which reviews a milestone delivery and writes a
signed report to `ForemanReviewReceiver` on Arc Testnet. Workflow internals are in
[`foreman-review/README.md`](foreman-review/README.md).

Status: simulation with a real broadcast through Chainlink's `MockKeystoneForwarder`. Deploy access is not enabled
on our CRE account, so the workflow has not run on a DON. The mainnet escrow flow does not depend on this.

| | |
| --- | --- |
| Chain | Arc Testnet, chain id 5042002, CRE name `arc-testnet`, RPC `https://rpc.testnet.arc.io` |
| Receiver | `0xD069469B0828bACB492a18614f93159D255b0E6d` (set in `foreman-review/config.staging.json`) |
| Forwarder | MockKeystoneForwarder `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| Report | `abi.encode(uint256 jobId, uint256 index, uint8 verdict, bytes32 reasonHash, bytes32 evidenceHash)`, verdict 0 approve, 1 revision, 2 escalate |

## Setup

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash      # CRE CLI (tested with v1.38.0), then: cre login
curl -fsSL https://bun.sh/install | bash                # Bun
cd cre/foreman-review && bun install && cd ..
cp .env.example .env
```

Edit `cre/.env` (git-ignored, never commit it):

- `CRE_ETH_PRIVATE_KEY`: a **testnet-only** key holding a little Arc Testnet USDC (gas is paid in native USDC). Never use a mainnet key.
- `GEMINI_API_KEY`: optional. Leave it empty (the line must exist) to force the deterministic fallback.

## Simulate

Run from `cre/`. The CLI needs a pseudo-TTY, hence `script`; `< /dev/null` avoids an intermittent `tcgetattr` error.
The payload path is plain: CLI 1.38.0 does not accept the `@` prefix.

```bash
# dry run: runs everything, the report write is simulated (tx hash 0x000...)
script -q /dev/null cre workflow simulate foreman-review --non-interactive --trigger-index 0 \
  --http-payload ./foreman-review/payloads/pilot-pr1.json --target staging-settings < /dev/null

# real transaction through the MockKeystoneForwarder
script -q /dev/null cre workflow simulate foreman-review --non-interactive --trigger-index 0 \
  --http-payload ./foreman-review/payloads/pilot-pr1.json --target staging-settings --broadcast < /dev/null
```

Payloads: `pilot-pr1.json` (the real pilot, job 2 milestone 1, expects approve) and `negative-wrong-file.json`
(expects a revision).

## From the Foreman CLI

`foreman attest` builds the payload from the plan file and the on-chain milestone, runs the broadcast simulation,
prints the verdict, hashes and the Arc Testnet explorer link, checks the `ReviewAttested` event on chain, and
appends the result to `log/cre-attestations.jsonl`:

```bash
set -a; source ~/.config/foreman/run.env; set +a        # FOREMAN_POLICY etc. for the mainnet reads
node agent/foreman.mjs attest --job 2 --index 0
```

Set `CRE_BIN` if `cre` is not at `~/.cre/bin/cre`.

## Verify on chain

```bash
cast call 0xD069469B0828bACB492a18614f93159D255b0E6d 'attestation(uint256,uint256)(uint8,bytes32,bytes32,uint256)' 2 0 \
  --rpc-url https://rpc.testnet.arc.io          # verdict, reasonHash, evidenceHash, timestamp
cast receipt <txHash> --rpc-url https://rpc.testnet.arc.io
```

The `reasonHash` equals the keccak256 of the canonical decision record the workflow logs (`Decision record: ...`).

## Test

```bash
cd cre/foreman-review && bun test && bun run typecheck
cd ../.. && forge test --match-contract ForemanReviewReceiver
```

## Redeploying the receiver

`bash scripts/deploy-cre-receiver.sh` (refuses to run unless the RPC is chain 5042002 and the wallet is the testnet
one) deploys, verifies on Sourcify and writes `~/.config/foreman/cre.env`. Put the new address in
`foreman-review/config.staging.json` and `config.production.json`.
