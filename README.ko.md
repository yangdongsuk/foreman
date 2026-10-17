# Foreman

**스마트 컨트랙트가 강제하는 지출 한도 안에서 소규모 사업체의 프리랜서 계약을 관리하는 AI 에이전트.** Arc 기반, USDC 정산.

**라이브 대시보드:** https://yangdongsuk.github.io/foreman/ · **데모 영상:** [VIDEO_LINK] · **컨트랙트:** [배포](#배포-arc-메인넷) 섹션 참고

Foreman은 평이한 영어로 쓴 브리프에서 작업 범위와 마일스톤 초안을 작성하고, 대금을 에스크로에 예치하고, 모든 납품물을 유료 도구로 검수합니다. 검수가 끝나면 승인하거나, 구체적인 피드백을 붙여 수정을 요청하거나, 오너에게 넘깁니다. Foreman이 지급할 수 있는 돈은 오너가 이미 에스크로에 넣어 둔 금액뿐입니다. 지급은 자동 승인 한도와 일일 한도 안에서만, 그리고 프리랜서가 실제로 제출한 작업에 대해서만 가능합니다. 그보다 큰 금액은 오너의 공동 서명이 필요하고, 킬 스위치를 누르면 Foreman은 즉시 멈춥니다. 모든 결정에는 판단 근거가 함께 남고, 그 근거의 해시는 온체인에 기록됩니다.

## 해결하려는 문제

소규모 사업체는 이미 마일스톤 단위로 외주 인력에게 대금을 지급하고 있습니다. 작업 범위 작성, 납품물 확인, 수정 작업 챙기기, 대금 지급 같은 계약 관리의 대부분은 AI 에이전트가 맡을 수 있습니다. 발목을 잡는 것은 지갑입니다. 지금 에이전트의 예산은 프롬프트에 적힌 한 문장일 뿐입니다. 그래서 프롬프트 인젝션 한 번, 모델이 환각으로 내놓은 "문제없어 보입니다"라는 한마디, 키 유출 한 번이면 에이전트가 가진 돈이 통째로 빠져나갈 수 있습니다.

Foreman은 예산을 프롬프트에서 꺼내 스마트 컨트랙트로 옮깁니다:

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
2. **유료 도구로 증거를 모읍니다.** 모델은 매 턴마다 검수 기준 원문, 프리랜서의 메모, 지금까지 모은 증거, 가격이 적힌 도구 카탈로그, 남은 도구 예산, 온체인 한도를 확인합니다. 그런 다음 도구를 하나 호출하거나 결정을 내립니다. 모든 호출은 Tollgate 바우처로 결제하며, 바우처가 없으면 도구 서버가 `402 Payment Required`와 함께 결제 조건을 응답합니다.
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
| ForemanPolicy (신규) | [POLICY_ROW] |
| Stagepay (마일스톤 에스크로) | [`0x0A87039a127b600cF9B85d4C33d97c08054e15E6`](https://explorer.arc.io/address/0x0A87039a127b600cF9B85d4C33d97c08054e15E6) · [Sourcify](https://repo.sourcify.dev/5042/0x0A87039a127b600cF9B85d4C33d97c08054e15E6) |
| Tollgate (호출당 결제 채널) | [`0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F`](https://explorer.arc.io/address/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) · [Sourcify](https://repo.sourcify.dev/5042/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) |

[MAINNET_RUN]

## 실행하기

요구 사항: Node 24, Foundry, 그리고 모델용으로 `ANTHROPIC_API_KEY` 또는 로그인된 Claude Code CLI(`claude`) 중 하나.

```bash
npm install
forge test                      # policy contract tests, including a fuzz test of the daily cap
bash scripts/local-e2e.sh       # the whole workflow on a local anvil node with real model calls
```

Arc 메인넷에서는 다음과 같이 실행합니다(키는 환경 변수에서 읽으며, 각 역할은 `SPEC.md`를 참고하세요):

```bash
[MAINNET_COMMANDS]
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
- [TRACTION_NOTE]
- 알려진 한계: 정책당 오너는 한 명입니다. 모델은 오너 본인의 Anthropic 키 또는 Claude Code 로그인으로 실행됩니다. 도구 서버는 단일 프로세스입니다. 판단 근거 텍스트는 설계상 공개됩니다.

MIT 라이선스.
