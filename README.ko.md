# Foreman

**스마트 컨트랙트가 강제하는 지출 한도 안에서 소규모 사업체의 프리랜서 계약을 관리하는 AI 에이전트.** Arc 기반, USDC 정산.

**라이브 대시보드:** https://yangdongsuk.github.io/foreman/ · **데모 영상:** [YouTube (2:35)](https://youtu.be/VLXhugGEiH0) · [mp4](https://github.com/yangdongsuk/foreman/releases/download/v0.1.0-demo/foreman-demo.mp4) · **컨트랙트:** [배포](#배포-arc-메인넷) 섹션 참고

Foreman은 평이한 영어로 쓴 브리프를 바탕으로 작업 범위와 마일스톤 초안을 작성하고, 대금을 에스크로에 예치하고, 모든 납품물을 유료 도구로 검수합니다. 검수가 끝나면 승인하거나, 구체적인 피드백을 붙여 수정을 요청하거나, 오너에게 넘깁니다. Foreman이 지급할 수 있는 돈은 오너가 이미 에스크로에 넣어 둔 금액뿐입니다. 지급은 자동 승인 한도와 일일 한도 안에서만, 그리고 프리랜서가 실제로 제출한 작업에 대해서만 가능합니다. 한도를 넘는 금액은 오너의 공동 서명이 필요하고, 킬 스위치를 누르면 Foreman은 즉시 멈춥니다. 모든 결정에는 판단 근거가 함께 남고, 그 근거의 해시는 온체인에 기록됩니다.

## 해결하려는 문제

소규모 사업체는 이미 마일스톤 단위로 외주 인력에게 대금을 지급하고 있습니다. 작업 범위 작성, 납품물 확인, 수정 작업 챙기기, 대금 지급 같은 계약 관리의 대부분은 AI 에이전트가 맡을 수 있습니다. 발목을 잡는 것은 지갑입니다. 지금 에이전트의 예산은 프롬프트에 적힌 한 문장일 뿐입니다. 그래서 프롬프트 인젝션 한 번, 모델이 환각으로 내놓은 "문제없어 보입니다"라는 한마디, 키 유출 한 번이면 에이전트가 가진 돈이 통째로 빠져나갈 수 있습니다.

Foreman은 예산을 프롬프트에서 꺼내 스마트 컨트랙트로 옮깁니다:

| 한도 | 강제 주체 | 막아 주는 것 |
| --- | --- | --- |
| 에이전트는 작업 대금을 직접 보유하지 않습니다. 대금은 에스크로가 보관하고, 정책 컨트랙트가 에스크로의 유일한 클라이언트입니다 | `ForemanPolicy` + Stagepay | 탈취된 에이전트 키로 자금이 빠져나가는 일 |
| 프리랜서가 **제출한** 마일스톤에 대해서만 대금이 움직입니다 | `ForemanPolicy` (`NotSubmitted`) | 납품되지 않은 작업에 대금을 지급하는 일 |
| 마일스톤당 **자동 승인 한도** | `ForemanPolicy` (`OverAutoApproveCap`) | 잘못된 판단 한 번으로 큰 금액의 마일스톤이 지급되는 일 |
| 모든 작업을 합산한 **일일 지급 한도** | `ForemanPolicy` (`OverDailyCap`) | 짧은 시간 안에 같은 실수가 반복되는 일 |
| 한도 초과 시 → `agentEscalate`, 이어서 오너의 `ownerCosign` | `ForemanPolicy` (`NotEscalated`) | 사람의 확인 없이 이뤄지는 고액 지급 |
| **킬 스위치** `setPaused(true)`가 에이전트의 모든 동작을 멈춥니다. 오너 전용 함수는 계속 동작합니다 | `ForemanPolicy` (`IsPaused`) | 오작동하는 에이전트를 즉시 정지 |
| 도구 지출은 선불 채널로 상한을 두며, 에이전트가 이 채널에서 쓰는 키는 **자금이 없는 세션 키**입니다 | Tollgate | 걷잡을 수 없이 불어나는 도구 비용. 키가 유출돼도 손실은 최대 채널 잔액 |
| 마일스톤당 수정 요청은 최대 3회이며, 아무도 응답하지 않으면 검수 기간이 지난 뒤 프리랜서가 대금을 직접 받아 갈 수 있습니다 | Stagepay | 에이전트(또는 오너)가 완성된 작업을 볼모로 잡는 일 |

에이전트의 코드도 실행에 앞서 이 한도들을 확인하므로, 리버트(revert)될 트랜잭션을 보내는 대신 오너에게 에스컬레이션합니다. 다만 최종 권한은 컨트랙트가 쥐고 있으며, 프롬프트에는 돈을 맡기지 않습니다.

## 동작 방식

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

### 에이전트 루프

`agent/review.mjs`는 제출된 마일스톤 하나를 처음부터 끝까지 처리합니다.

1. **계획을 불러와 검증합니다.** 계획은 작업의 온체인 `termsHash`로 찾습니다. 파일의 해시가 일치하지 않으면 에이전트는 검수를 거부합니다.
2. **유료 도구로 증거를 모읍니다.** 모델은 매 턴마다 원문 그대로의 검수 기준, 프리랜서의 메모, 지금까지 모은 증거, 가격이 적힌 도구 카탈로그, 남은 도구 예산, 온체인 한도를 확인합니다. 그런 다음 도구를 하나 호출하거나 결정을 내립니다. 모든 호출은 Tollgate 바우처로 결제하며, 바우처가 없으면 도구 서버는 결제 조건을 담아 `402 Payment Required`로 응답합니다.
3. **결정합니다.** `approve`는 모든 기준이 *도구가 돌려준 증거*로 충족될 때만 선택합니다(프리랜서의 메모는 주장일 뿐 증거가 아닙니다). `request_revision`에는 구체적인 피드백이 따라붙으며, 이 피드백은 수정 요청 메모로 온체인에 전송됩니다. 증거만으로 결론을 낼 수 없거나 판단이 주관적이면 `escalate`를 선택합니다.
4. **코드의 가드레일이 최종 결정권을 가집니다.** 자동 승인 한도나 오늘 남은 일일 허용량을 넘는 승인은 에스컬레이션으로 바뀝니다. 네 번째 수정 요청도 에스컬레이션으로 바뀝니다. 충족되지 않은 기준이 있는데 승인하려 하면 수정 요청으로 바뀝니다. 검수 기간이 곧 끝날 때도, 모델 호출이 실패했을 때도 에스컬레이션으로 바뀝니다. 코드가 모델의 판단을 바꿀 때마다 그 내용이 기록에 남습니다.
5. **기록하고, 해시하고, 실행합니다.** 결정 기록(판정, 근거, 기준별 증거, 가드레일이 바꾼 내용, 영수증이 딸린 모든 도구 호출, 모델, 계획 해시)은 정규화된(canonical) JSON입니다. 이 기록의 keccak256 해시는 트랜잭션과 함께 `reasonHash`로 온체인에 기록되고, 기록 자체는 `web/data/decisions.json`에 게시됩니다.

### 직접 검증할 수 있는 결정 로그

대시보드는 Arc의 `AgentDecision` 이벤트를 읽고, 브라우저에서 `keccak256(canonicalJSON(record))`를 직접 다시 계산합니다. 게시된 판단 근거를 누군가 사후에 수정하면 검증 결과가 빨간색으로 바뀝니다. 정규화된 JSON이란 키를 정렬하고, 공백을 넣지 않고, bigint를 문자열로 표기한 JSON입니다(`agent/canonical.mjs`에 구현되어 있고, `web/app.js`에도 같은 로직이 들어 있습니다).

### 호출당 결제 도구 (Tollgate)

오너는 도구 제공자와 Tollgate 채널을 열고, 새로 만든 **세션 키**를 바우처 서명자로 지정합니다. 이 키에는 자금이 전혀 없고 가스비도 내지 않습니다. 각 호출의 `x-tollgate-voucher` 헤더에는 누적형 EIP-712 바우처가 담겨 있습니다. 제공자는 이 바우처를 오프체인에서 검증하고, 가스비를 들일 만한 시점에 가장 최근 바우처를 한 번의 트랜잭션으로 온체인에서 정산합니다. 에이전트는 매 단계마다 남은 도구 예산을 확인하고, 가장 저렴한 도구조차 감당할 수 없게 되면 도구 호출을 멈춥니다.

## Arc 위의 Circle 스택

- **USDC가 가스이자 정산 자산입니다.** 에이전트의 키에는 가스비로 쓸 USDC 몇 센트만 있으면 되고, 세션 키에는 아무것도 필요 없습니다. 두 번째 토큰은 어디에도 없습니다.
- **USDC와 EURC 에스크로.** `foreman fund --token EURC`를 실행하면 유로화 계약도 같은 규칙으로 에스크로에 예치할 수 있습니다.
- **1초 미만의 파이널리티.** "승인"은 곧 "지급 완료"를 뜻하며, "컨펌을 기다려 주세요"라는 뜻이 아닙니다.
- **Circle의 USDC용 ERC-20 인터페이스**(`0x3600…0000`, 소수점 6자리)를 모든 금액 계산에 사용합니다. 소수점 18자리의 네이티브 잔액은 가스비로만 쓰입니다.

## 배포 (Arc 메인넷)

| 컨트랙트 | 주소 |
| --- | --- |
| ForemanPolicy (신규) | [`0x2065a64a410E0610ebD654b4eC4ADE142e9A68E2`](https://explorer.arc.io/address/0x2065a64a410E0610ebD654b4eC4ADE142e9A68E2) ([배포 tx](https://explorer.arc.io/tx/0xc3bbbd93f49285d01922c21d59e3978f73e75a3ebdf5833eb0a8070a028c0750)) · [Sourcify](https://repo.sourcify.dev/5042/0x2065a64a410E0610ebD654b4eC4ADE142e9A68E2) · 한도: 마일스톤당 0.10 USDC, 하루 0.15 USDC |
| Stagepay (마일스톤 에스크로) | [`0x0A87039a127b600cF9B85d4C33d97c08054e15E6`](https://explorer.arc.io/address/0x0A87039a127b600cF9B85d4C33d97c08054e15E6) · [Sourcify](https://repo.sourcify.dev/5042/0x0A87039a127b600cF9B85d4C33d97c08054e15E6) |
| Tollgate (호출당 결제 채널) | [`0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F`](https://explorer.arc.io/address/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) · [Sourcify](https://repo.sourcify.dev/5042/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) |

### 메인넷에서 실행한 첫 작업

2026-10-18(KST)에 우리 쪽 테스트 프리랜서 계정으로 진행한 시범 작업입니다. 모든 단계가 Arc 메인넷 트랜잭션입니다.

| 단계 | 주체 | 증거 |
| --- | --- | --- |
| 브리프 → 승인 기준이 포함된 계획, 해시 고정(`termsHash 0x92e83f08…`) | 에이전트 | [계획 파일](plans/0x92e83f085e62697eb5839189f3a50da70c3d68be99dc6fa0903ede42846cef14.json) |
| 도구 채널 개설(0.04 USDC). 바우처 서명은 자금이 없는 세션 키가 담당 | 오너 | [tx](https://explorer.arc.io/tx/0xfb41a270f73ece1411fb5265538dfa88204e5b1900b2cbc930a179162ef0eb6b) |
| 정책 컨트랙트를 통해 작업 #2 예치: 0.05 + 0.15 USDC | 오너 | [tx](https://explorer.arc.io/tx/0xd7f24735ba2d3cd3b8946a1f04206045fb5dc32c4828606817476e1c266fe4cc) |
| 마일스톤 1 제출: [PR #1](https://github.com/yangdongsuk/foreman/pull/1), 한도 표가 빠진 한국어 README | 프리랜서 | [tx](https://explorer.arc.io/tx/0x5d22b5580bc5454d8a95999bfe2b575037789a8f4157f988869701e3cbebc441) |
| 에이전트가 도구 2회(0.003 USDC)를 결제해 누락된 표를 찾아내고 구체적인 메모와 함께 **수정 요청** | 에이전트 | [tx](https://explorer.arc.io/tx/0xcc1b8fd53b70fbfb5ede79378bc7a662d7e22138b0a00cef79a75729a2c74f31) |
| 표를 추가해 마일스톤 1 재제출 | 프리랜서 | [tx](https://explorer.arc.io/tx/0x0d2de46370a8c53051b8f32e4ea5ef27d1f0e205b3ff180a215970b4174696a0) |
| 에이전트가 두 파일을 끝까지 비교(도구 3회, 0.004 USDC)하고 **승인**: 0.05 USDC 지급 | 에이전트 | [tx](https://explorer.arc.io/tx/0x68f3a00f44fbbe143160ea4f8bb39883737b9f36983d87e4da8bff80fc590043) |
| 마일스톤 2 제출: [한국어 랜딩 페이지](https://yangdongsuk.github.io/foreman/ko.html) | 프리랜서 | [tx](https://explorer.arc.io/tx/0xc67f3bd315ef7de3458a8727bea4cee0b8c6a978196bb45da02059eeff910a52) |
| 에이전트가 **에스컬레이션**: 0.15 USDC가 한도 0.10을 넘고, 링크 대상을 확인하지 못했다고 명시 | 에이전트 | [tx](https://explorer.arc.io/tx/0x8bc7b7ae67d3a88829135eb2fc35d91b5e2f13a0cff011cc21d544290eec9ba0) |
| 오너가 지적된 링크를 확인하고 **공동 서명**: 0.15 USDC 지급 | 오너 | [tx](https://explorer.arc.io/tx/0x0ccefae5e7fb85d5bdaf58ab0da77ae27e4ff583c24d1e2ef69c757a73233c8e) |
| 킬 스위치 켜기 → 에이전트 호출이 `IsPaused`로 거부됨 → 킬 스위치 끄기 | 오너 | [정지](https://explorer.arc.io/tx/0xe33eb5dfe24f7a6085dc4e35fcfda5e3dce9c0dca60ec1896809e819e5f10151) · [재개](https://explorer.arc.io/tx/0x1c4dd464d906950b9320ae68bfde31b699f4f77daf68f4593bc1dc545b2682ef) |
| 도구 제공자가 바우처 0.012 USDC를 트랜잭션 3건으로 정산 | 제공자 | [1](https://explorer.arc.io/tx/0x68d6beecde5856388705465ff5cf76510fdfdda35612e2eed17f05cfba975ad6) · [2](https://explorer.arc.io/tx/0x3b7e07d82914490ab3330a8b5cb23643c9b320e797f0013a76aad71544622364) · [3](https://explorer.arc.io/tx/0x2e2cdda8daf962632f9e45b6c3fffbb578ae09402b6f8a120a799c3df1e53853) |

에이전트 트랜잭션 3건의 결정 기록은 [`web/data/decisions.json`](web/data/decisions.json)에 있고(대시보드가 해시를 다시 검증합니다), 각 단계의 터미널 출력은 [`demo/transcripts/`](demo/transcripts/)에 있습니다.

**이번 실행에서 배운 점**(같은 날 밤 수정): 첫 검수에서는 파일의 앞 3,000자만 보였기 때문에 이제 원문 텍스트 납품물은 전체를 돌려줍니다. 랜딩 페이지 검수에서는 링크 대상을 볼 수 없었기 때문에 `http-check`가 이제 모든 링크와 해석된 URL을 돌려줍니다. 저장소 README 조회가 GitHub의 raw 미디어 타입을 잘못 파싱하던 문제도 고쳤습니다.

## 실행하기

요구 사항: Node 24, Foundry, 그리고 모델용으로 `ANTHROPIC_API_KEY` 또는 로그인된 Claude Code CLI(`claude`) 중 하나.

```bash
npm install
forge test                      # policy contract tests, including a fuzz test of the daily cap
bash scripts/local-e2e.sh       # the whole workflow on a local anvil node with real model calls
```

Arc 메인넷에서는 다음과 같이 실행합니다(키는 환경 변수에서 읽으며, 각 역할은 `SPEC.md`를 참고하세요):

```bash
cd foreman && npm install
forge create contracts/src/ForemanPolicy.sol:ForemanPolicy --rpc-url https://rpc.mainnet.arc.io \
  --private-key $OWNER_KEY --broadcast --gas-price 40gwei --priority-gas-price 1gwei \
  --constructor-args 0x0A87039a127b600cF9B85d4C33d97c08054e15E6 $AGENT_ADDRESS 100000 150000
export FOREMAN_POLICY=0x... POLICY_DEPLOY_BLOCK=...
DEPOSIT_USDC=0.04 node scripts/open-channel.mjs          # TOLLGATE_CHANNEL=0x... 출력
node tools/server.mjs &                                   # :8790에서 호출당 결제 도구 실행
node agent/foreman.mjs plan --brief "..." --budget 0.2 --yes
node agent/foreman.mjs fund --plan <termsHash> --freelancer <address>
node agent/foreman.mjs watch --job <id>                   # 제출이 들어오는 대로 검수
node agent/foreman.mjs cosign --job <id> --index <i>      # 오너, 에스컬레이션 건 처리
node agent/foreman.mjs pause                              # 오너 킬 스위치 (resume으로 해제)
```

## 저장소 구조

| 경로 | 설명 |
| --- | --- |
| `contracts/src/ForemanPolicy.sol` | 에이전트가 온체인에서 부여받은 권한(한도, 공동 서명, 킬 스위치). 테스트는 `contracts/test/`에 있습니다 |
| `agent/` | Foreman 에이전트와 CLI: 계획 수립, 검수 루프, 가드레일, 결정 기록 |
| `tools/` | Tollgate가 보호하는 호출당 결제 도구 서버(`http-check`, `github`, `rubric`) |
| `web/` | Arc를 읽고 결정 로그를 검증하는 정적 대시보드 |
| `vendor/tollgate.mjs`, `contracts/src/vendor/` | Tollgate SDK와 Foreman이 기반으로 삼는 두 컨트랙트(수정 없이 그대로 사용) |

## 현황과 솔직한 참고 사항

- Tameion Agents Hackathon 기간에 만들었습니다(커밋 기록 참고). Stagepay와 Tollgate는 해커톤 직전 한 주 동안 작성해 배포했으며, 해커톤 기간에는 변경하지 않았습니다.
- 지금까지의 트랙션은 시범 운영 수준입니다. 마일스톤 2개짜리 작업 1건, 에이전트 결정 3건과 오너 공동 서명 1건, 예치 후 지급된 0.20 USDC, 바우처로 결제된 도구 호출 0.012 USDC이며, 모두 우리 쪽 오너·프리랜서 계정으로 진행했습니다. 아직 외부 고객은 없습니다.
- 알려진 한계: 정책당 오너는 한 명입니다. 모델은 오너 본인의 Anthropic 키 또는 Claude Code 로그인으로 실행됩니다. 도구 서버는 단일 프로세스입니다. 판단 근거 텍스트는 설계상 공개됩니다.

MIT 라이선스.
