#!/usr/bin/env bash
# Deploy ForemanReviewReceiver to Arc TESTNET (chain 5042002) for the Chainlink CRE workflow.
# Uses the arc-canteen testnet wallet. Never run with a mainnet key.
# Output: ~/.config/foreman/cre.env  (CRE_RECEIVER, CRE_RECEIVER_DEPLOY_TX, ...)
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC="${ARC_TESTNET_RPC:-https://rpc.testnet.arc.io}"
CHAIN_ID=5042002
# MockKeystoneForwarder for arc-testnet (CRE "Simulation Testnets" forwarder directory).
# `cre workflow simulate --broadcast` sends its report through this contract.
MOCK_FORWARDER="${MOCK_FORWARDER:-0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1}"
WALLET="${ARC_CANTEEN_WALLET:-$HOME/.arc-canteen/wallet.yaml}"
OUT_DIR="$HOME/.config/foreman"
OUT_ENV="$OUT_DIR/cre.env"

[[ "$(cast chain-id --rpc-url "$RPC")" == "$CHAIN_ID" ]] || { echo "RPC is not Arc Testnet ($CHAIN_ID)" >&2; exit 1; }
grep -q "chain: testnet" "$WALLET" || { echo "wallet.yaml is not a testnet wallet; refusing" >&2; exit 1; }

# Read the key into a variable only; it is never echoed.
PK="$(awk -F': *' '/^private_key:/{gsub(/[\047" ]/,"",$2); print $2}' "$WALLET")"
[[ -n "$PK" ]] || { echo "no private_key in $WALLET" >&2; exit 1; }
[[ "$PK" == 0x* ]] || PK="0x$PK"
DEPLOYER="$(cast wallet address --private-key "$PK")"
echo "deployer  $DEPLOYER"
echo "forwarder $MOCK_FORWARDER"
echo "balance   $(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether) USDC (native)"

cd "$ROOT"
forge build >/dev/null

# Arc drops txs below a 20 gwei fee, hence the explicit gas price flags.
JSON="$(forge create contracts/src/cre/ForemanReviewReceiver.sol:ForemanReviewReceiver \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --json \
  --gas-price 40gwei --priority-gas-price 1gwei \
  --constructor-args "$MOCK_FORWARDER")"
unset PK

ADDR="$(printf '%s' "$JSON" | sed -n 's/.*"deployedTo" *: *"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)"
TX="$(printf '%s' "$JSON" | sed -n 's/.*"transactionHash" *: *"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)"
[[ -n "$ADDR" && -n "$TX" ]] || { echo "deploy failed: $JSON" >&2; exit 1; }
echo "receiver  $ADDR"
echo "deploy tx $TX"

# Best-effort Sourcify verification (explorer: testnet.arcscan.app).
if forge verify-contract "$ADDR" contracts/src/cre/ForemanReviewReceiver.sol:ForemanReviewReceiver \
  --chain-id "$CHAIN_ID" --verifier sourcify --verifier-url https://sourcify.dev/server/ \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$MOCK_FORWARDER")" \
  --watch 2>&1 | tail -5; then
  echo "sourcify  https://repo.sourcify.dev/$CHAIN_ID/$ADDR"
else
  echo "sourcify verification failed (non-fatal)" >&2
fi

mkdir -p "$OUT_DIR"
umask 077
cat > "$OUT_ENV" <<ENV
CRE_RECEIVER=$ADDR
CRE_RECEIVER_DEPLOY_TX=$TX
CRE_FORWARDER=$MOCK_FORWARDER
CRE_CHAIN_NAME=arc-testnet
CRE_CHAIN_ID=$CHAIN_ID
ENV
chmod 600 "$OUT_ENV"
echo "wrote $OUT_ENV"
