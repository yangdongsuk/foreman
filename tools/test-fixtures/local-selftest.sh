#!/usr/bin/env bash
# Runs tools/selftest.mjs against a throwaway local anvil node (chain id 5042, port 8556).
# Deploys MockUSDC + the vendored Tollgate from an isolated temp Foundry project, so it never
# touches this repo's out/ or cache/ directories.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=8556
RPC="http://127.0.0.1:$PORT"
# anvil's well-known dev accounts 0, 1 and 2: owner (payer), provider, session signer
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
PROVIDER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
SESSION_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

TMP="$(mktemp -d)"
anvil --chain-id 5042 --port "$PORT" --silent &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$TMP/src"
cp "$ROOT/tools/test-fixtures/MockUSDC.sol" "$ROOT/contracts/src/vendor/Tollgate.sol" "$TMP/src/"
printf '[profile.default]\nsrc = "src"\nsolc_version = "0.8.28"\noptimizer = true\n' > "$TMP/foundry.toml"

for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

deploy() {
  forge create --root "$TMP" "$1" --rpc-url "$RPC" --private-key "$OWNER_KEY" --broadcast --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("{"))).deployedTo))'
}
USDC="$(deploy src/MockUSDC.sol:MockUSDC)"
TOLLGATE="$(deploy src/Tollgate.sol:Tollgate)"
echo "MockUSDC $USDC  Tollgate $TOLLGATE"

cd "$ROOT"
RPC_URL="$RPC" CHAIN_ID=5042 USDC="$USDC" TOLLGATE="$TOLLGATE" \
  OWNER_KEY="$OWNER_KEY" PROVIDER_KEY="$PROVIDER_KEY" SESSION_KEY="$SESSION_KEY" \
  node tools/selftest.mjs
