#!/usr/bin/env bash
# Full Foreman workflow on a local anvil node (chain id 5042): no real money, real `claude` CLI as the model.
#
#   scripts/local-e2e.sh                # run everything, print PASS/FAIL per step, exit 1 on any FAIL
#   E2E_KEEP=1 scripts/local-e2e.sh     # keep the work directory (plans, decision log, server logs)
#
# Everything the run writes (plans, decision log, meter state, redemption log) goes to a scratch directory,
# so web/data/decisions.json and plans/ of the repo are never touched.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ANVIL_PORT=8557
TOOLS_PORT=8792
WORK="${E2E_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/foreman-e2e.XXXXXX")}"
mkdir -p "$WORK"

# anvil's well-known dev accounts 0..4
export OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export PROVIDER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export SESSION_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
export AGENT_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
export FREELANCER_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
export OWNER_ADDRESS PROVIDER_ADDRESS SESSION_ADDRESS AGENT_ADDRESS FREELANCER_ADDRESS
OWNER_ADDRESS=$(cast wallet address --private-key "$OWNER_KEY")
PROVIDER_ADDRESS=$(cast wallet address --private-key "$PROVIDER_KEY")
SESSION_ADDRESS=$(cast wallet address --private-key "$SESSION_KEY")
AGENT_ADDRESS=$(cast wallet address --private-key "$AGENT_KEY")
FREELANCER_ADDRESS=$(cast wallet address --private-key "$FREELANCER_KEY")

# Limits: the agent may approve up to 0.1 USDC per milestone, 0.3 USDC per day.
export AUTO_APPROVE_CAP=100000 DAILY_CAP=300000 DEPOSIT_USDC=1
export RPC_URL="http://127.0.0.1:$ANVIL_PORT" CHAIN_ID=5042 POLICY_DEPLOY_BLOCK=0
export PORT=$TOOLS_PORT TOOLS_URL="http://127.0.0.1:$TOOLS_PORT"
# Keep local-run artefacts away from the repo (the mainnet run writes the real plans/, log/ and web/data/).
export FOREMAN_PLANS_DIR="$WORK/plans" FOREMAN_LOG_DIR="$WORK/log" FOREMAN_STATE_DIR="$WORK/state" FOREMAN_WEB_DATA_DIR="$WORK/web-data"
export REDEMPTIONS_LOG="$WORK/log/redemptions.jsonl"
mkdir -p "$FOREMAN_PLANS_DIR" "$FOREMAN_LOG_DIR" "$FOREMAN_STATE_DIR" "$FOREMAN_WEB_DATA_DIR"

REPO_DECISIONS_SUM_BEFORE=$(shasum web/data/decisions.json 2>/dev/null | cut -d' ' -f1)
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  if [ -z "${E2E_KEEP:-}" ] && [ -z "${E2E_DIR:-}" ]; then rm -rf "$WORK"; else echo "work dir kept: $WORK"; fi
}
trap cleanup EXIT

# ------------------------------------------------------------------ tiny test harness
PASS=0; FAIL=0; RESULTS=()
note() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1${2:+  ($2)}"); printf '  \033[31mFAIL\033[0m  %s%s\n' "$1" "${2:+  ($2)}"; }
# check "<name>" "<expected>" "<actual>"
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$2', got '$3'"; fi; }
# run "<name>" <logfile> cmd...   (PASS when the command exits 0; its output goes to the log file)
run() { local name="$1" log="$2"; shift 2; if "$@" >"$log" 2>&1; then ok "$name"; return 0; else bad "$name" "see $log"; tail -n 15 "$log" | sed 's/^/        /'; return 1; fi; }
abort() { bad "$1" "${2:-}"; summary; exit 1; }
summary() {
  printf '\n\033[1m== result\033[0m\n'
  printf '  %s\n' "${RESULTS[@]}"
  printf '\n  %d passed, %d failed\n' "$PASS" "$FAIL"
}
probe() { node scripts/e2e-probe.mjs "$@"; }
fm() { node agent/foreman.mjs "$@"; }
# Decisions are logged oldest first, one JSON line per decision.
decision_field() { jq -r "select(.record.index==$1) | $2" "$FOREMAN_LOG_DIR/decisions.jsonl" | tail -n 1; }

# ------------------------------------------------------------------ 1. contracts
note "1. contracts"
run "forge test (ForemanPolicy, 25 tests incl. fuzz)" "$WORK/forge-test.log" forge test || abort "forge test"
tail -n 4 "$WORK/forge-test.log" | sed 's/^/        /'

# ------------------------------------------------------------------ 2. node + deploy
note "2. local chain and deployment"
anvil --chain-id 5042 --port "$ANVIL_PORT" --silent &
PIDS+=($!)
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep 0.2; done
cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 || abort "anvil started"

if forge script contracts/script/LocalSetup.s.sol --rpc-url "$RPC_URL" --broadcast >"$WORK/deploy.log" 2>&1; then
  eval "$(grep -E '^\s*(STAGEPAY|TOLLGATE|USDC|FOREMAN_POLICY)=' "$WORK/deploy.log" | sed 's/^ *//; s/^/export /')"
  [ -n "${FOREMAN_POLICY:-}" ] && [ -n "${STAGEPAY:-}" ] && [ -n "${TOLLGATE:-}" ] && [ -n "${USDC:-}" ] \
    && ok "LocalSetup deployed MockUSDC, Stagepay, Tollgate, ForemanPolicy" || abort "LocalSetup printed addresses" "$WORK/deploy.log"
else
  tail -n 20 "$WORK/deploy.log"; abort "LocalSetup deploys" "see $WORK/deploy.log"
fi
PROVIDER_START=$(probe balance "$PROVIDER_ADDRESS")
echo "        policy $FOREMAN_POLICY  stagepay $STAGEPAY  tollgate $TOLLGATE  usdc $USDC"
check "policy owner is OWNER" "$OWNER_ADDRESS" "$(cast call "$FOREMAN_POLICY" 'owner()(address)' --rpc-url "$RPC_URL")"
check "policy agent is AGENT" "$AGENT_ADDRESS" "$(cast call "$FOREMAN_POLICY" 'agent()(address)' --rpc-url "$RPC_URL")"

# ------------------------------------------------------------------ 3. tollgate channel + tools server
note "3. Tollgate channel and tool server"
if node scripts/open-channel.mjs >"$WORK/channel.out" 2>"$WORK/channel.err"; then
  export TOLLGATE_CHANNEL; TOLLGATE_CHANNEL=$(sed -n 's/^TOLLGATE_CHANNEL=//p' "$WORK/channel.out")
  [ -n "$TOLLGATE_CHANNEL" ] && ok "owner opened a 1 USDC channel to PROVIDER, SESSION as signer ($TOLLGATE_CHANNEL)" || abort "channel id printed"
else
  cat "$WORK/channel.err"; abort "open-channel.mjs"
fi

node tools/server.mjs >"$WORK/tools-server.log" 2>&1 &
TOOLS_PID=$!; PIDS+=($TOOLS_PID)
for _ in $(seq 1 50); do curl -fsS "$TOOLS_URL/health" >/dev/null 2>&1 && break; sleep 0.2; done
TOOLS_JSON=$(curl -fsS "$TOOLS_URL/tools" 2>/dev/null || echo '{}')
check "tool server up, catalog lists http-check, github, rubric" "github,http-check,rubric" "$(echo "$TOOLS_JSON" | jq -r '[.tools[].name] | sort | join(",")')"
check "unpaid call is answered with HTTP 402" "402" "$(curl -s -o /dev/null -w '%{http_code}' "$TOOLS_URL/tools/http-check?url=https://example.com")"

# ------------------------------------------------------------------ 4. plan
note "4. plan (real model, budget 0.3 USDC, 2 milestones, the second above the 0.1 USDC auto-approve cap)"
BRIEF="Our small studio needs a public GitHub repository for a tiny escrow web app. Split it into exactly 2 milestones. Milestone 1 costs 0.1 USDC: a public GitHub repository with a README that explains what the app does and the Solidity source of the escrow contract. Milestone 2 costs 0.2 USDC: a final submission, a public GitHub repository link that has the contract source, a README with setup instructions and a tests folder. Both deliverables are checked by reading the public GitHub repository page, so every acceptance criterion must be verifiable from the repository's README, file list and latest commit. Two criteria per milestone at most."
PLAN_OK=0
for attempt in 1 2 3; do
  rm -f "$FOREMAN_PLANS_DIR"/*.json
  if fm plan --brief "$BRIEF" --budget 0.3 --yes >"$WORK/plan.log" 2>&1; then
    PLAN_FILE=$(ls "$FOREMAN_PLANS_DIR"/*.json 2>/dev/null | head -n 1)
    if [ -n "$PLAN_FILE" ] && [ "$(jq '.plan.milestones | length' "$PLAN_FILE")" = 2 ] \
       && [ "$(jq '.plan.milestones[0].amountUSDC <= 0.1 and .plan.milestones[1].amountUSDC > 0.1' "$PLAN_FILE")" = true ]; then PLAN_OK=1; break; fi
  fi
  echo "        attempt $attempt did not give 2 milestones with m1 <= 0.1 < m2, retrying"
done
[ "$PLAN_OK" = 1 ] && ok "plan drafted: 2 milestones, m2 flagged for owner co-sign, within budget" || { tail -n 25 "$WORK/plan.log"; abort "plan" "see $WORK/plan.log"; }
TERMS_HASH=$(basename "$PLAN_FILE" .json)
jq -r '.plan.milestones[] | "        - \(.name) (\(.amountUSDC) USDC)"' "$PLAN_FILE"
echo "        terms hash $TERMS_HASH"

# ------------------------------------------------------------------ 5. fund
note "5. fund the job through ForemanPolicy"
run "owner funded the job (policy is the Stagepay client)" "$WORK/fund.log" fm fund --plan "$TERMS_HASH" --freelancer "$FREELANCER_ADDRESS" || abort "fund"
check "policy manages exactly one job" "1" "$(probe job-count)"
JOB=$(cast call "$FOREMAN_POLICY" 'jobAt(uint256)(uint256)' 0 --rpc-url "$RPC_URL")
check "milestone 1 is Funded" "Funded" "$(probe milestone "$JOB" 0)"
check "milestone 2 is Funded" "Funded" "$(probe milestone "$JOB" 1)"

# ------------------------------------------------------------------ 6. milestone 1
note "6. milestone 1: freelancer submits, agent reviews with paid tools and approves"
GH_URL="https://github.com/yangdongsuk/stagepay"
run "freelancer submitted milestone 1 with a GitHub link" "$WORK/submit1.log" fm submit --job "$JOB" --index 0 \
  --note "Milestone 1 is ready: the repository is public at $GH_URL with a README describing the app and the escrow contract source under contracts/." || abort "submit 1"
check "milestone 1 is Submitted" "Submitted" "$(probe milestone "$JOB" 0)"
FREELANCER_BEFORE=$(probe balance "$FREELANCER_ADDRESS")

run "agent reviewed milestone 1" "$WORK/review1.log" fm review --job "$JOB" --index 0 || abort "review 1"
cat "$WORK/review1.log" | sed 's/^/        /'
V1=$(decision_field 0 '.record.verdict')
STATUS1=$(probe milestone "$JOB" 0)
if [ "$V1" = approve ]; then
  check "agent approved milestone 1 and Stagepay released it" "Released" "$STATUS1"
  check "freelancer received 0.1 USDC" "$((FREELANCER_BEFORE + 100000))" "$(probe balance "$FREELANCER_ADDRESS")"
else
  bad "agent approved milestone 1" "verdict was '$V1': $(decision_field 0 '.record.rationale' | cut -c1-300)"
fi
TOOLS_USED=$(decision_field 0 '[.record.steps[] | select(.tool != null)] | length')
[ "${TOOLS_USED:-0}" -ge 1 ] && ok "agent paid for $TOOLS_USED tool call(s) with Tollgate vouchers" || bad "agent used at least one paid tool"
check "decision record hash equals the on-chain reasonHash" "true" "$(node -e '
  import("./agent/canonical.mjs").then(async (m) => {
    const fs = await import("node:fs");
    const rows = fs.readFileSync(process.env.FOREMAN_LOG_DIR + "/decisions.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    console.log(String(rows.every((d) => m.canonicalHash(d.record) === d.reasonHash)));
  })')"

# ------------------------------------------------------------------ 7. milestone 2
note "7. milestone 2 (0.2 USDC, above the cap): agent must escalate, owner co-signs"
run "freelancer submitted milestone 2 with a GitHub link" "$WORK/submit2.log" fm submit --job "$JOB" --index 1 \
  --note "Milestone 2 is ready: final submission at $GH_URL with the contract source, a README with setup instructions and the tests folder." || abort "submit 2"
run "agent reviewed milestone 2" "$WORK/review2.log" fm review --job "$JOB" --index 1 || abort "review 2"
cat "$WORK/review2.log" | sed 's/^/        /'
V2=$(decision_field 1 '.record.verdict')
check "agent escalated milestone 2 (never approved above the cap)" "escalate" "$V2"
check "milestone 2 still Submitted, nothing released" "Submitted" "$(probe milestone "$JOB" 1)"
check "milestone 2 is flagged escalated on chain" "true" "$(probe escalated "$JOB" 1)"
decision_field 1 '.record.guardrails | join("; ")' | grep -q over_auto_approve_cap \
  && ok "guardrail recorded: over_auto_approve_cap" || echo "        (model escalated on its own, no guardrail needed)"
FREELANCER_BEFORE2=$(probe balance "$FREELANCER_ADDRESS")
run "owner co-signed milestone 2" "$WORK/cosign.log" fm cosign --job "$JOB" --index 1 || abort "cosign"
check "milestone 2 Released after co-sign" "Released" "$(probe milestone "$JOB" 1)"
check "freelancer received 0.2 USDC" "$((FREELANCER_BEFORE2 + 200000))" "$(probe balance "$FREELANCER_ADDRESS")"
run "foreman status shows the job" "$WORK/status.log" fm status --job "$JOB"
sed 's/^/        /' "$WORK/status.log"

# ------------------------------------------------------------------ 8. kill switch
note "8. kill switch"
run "owner paused the policy" "$WORK/pause.log" fm pause || abort "pause"
check "paused: the contract rejects the agent with IsPaused" "IsPaused" "$(probe agent-approve "$JOB" 0)"
run "owner resumed the policy" "$WORK/resume.log" fm resume || abort "resume"
check "resumed: the agent is past the kill switch (now NotSubmitted, nothing left to approve)" "NotSubmitted" "$(probe agent-approve "$JOB" 0)"

# ------------------------------------------------------------------ 9. tool revenue
note "9. provider redeems the vouchers"
SPENT=$(jq -s '[.[].record.toolSpendUnits | tonumber] | add' "$FOREMAN_LOG_DIR/decisions.jsonl")
curl -fsS -X POST "$TOOLS_URL/admin/redeem" >"$WORK/redeem.json" 2>&1 || true
sleep 1
REDEEMED=$(probe tollgate-redeemed "$TOLLGATE_CHANNEL")
[ "$REDEEMED" -gt 0 ] 2>/dev/null && ok "vouchers redeemed on chain ($REDEEMED units)" || bad "vouchers redeemed on chain" "$(cat "$WORK/redeem.json")"
check "redeemed amount equals what the decision log says the agent spent" "$SPENT" "$REDEEMED"
check "provider USDC balance grew by the redeemed amount" "$((PROVIDER_START + REDEEMED))" "$(probe balance "$PROVIDER_ADDRESS")"
[ -s "$REDEMPTIONS_LOG" ] && ok "redemption logged in log/redemptions.jsonl" || bad "redemption logged"

# ------------------------------------------------------------------ 10. housekeeping
note "10. housekeeping"
check "repo web/data/decisions.json untouched by the local run" "$REPO_DECISIONS_SUM_BEFORE" "$(shasum web/data/decisions.json 2>/dev/null | cut -d' ' -f1)"
check "local decisions written to the scratch web data dir" "2" "$(jq 'length' "$FOREMAN_WEB_DATA_DIR/decisions.json" 2>/dev/null)"

kill "$TOOLS_PID" 2>/dev/null; wait "$TOOLS_PID" 2>/dev/null
summary
[ "$FAIL" -eq 0 ]
