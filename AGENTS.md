# 개발 AI 공용 규칙

이 저장소는 두 AI(Claude Code, Codex)가 함께 개발한다. 둘 다 이 파일을 따른다.
(Claude 는 CLAUDE.md 를 통해 이 파일을 읽는다.)

## 프로젝트

야구·축구·농구 10개 리그(KBO, MLB, K리그1, EPL, 라리가, 분데스리가, 세리에A, 리그1, KBL, NBA)의 일정·결과·뉴스·부상·이적을 모아
승부를 예측하는 웹 대시보드. Node.js 24, 의존성은 `@anthropic-ai/sdk`, `qrcode` 둘뿐(프레임워크 없음). 자세한 설명은 `README.md`.

```bash
npm install
npm test                           # 회귀 테스트 (SP_STATE_DIR 임시 폴더 사용)
npm run check                      # 10개 리그 실제 수집·예측 점검 (네트워크 필요)
node scripts/eval-attribution.js   # 기사 대상 팀 판단 평가 (31문장, 100% 유지)
npm start                          # http://localhost:3000 (이 PC 전용)
npm run phone                      # 폰·다른 PC용: 같은 와이파이 + Cloudflare 임시 터널 + 비밀번호 로그인
```

## 작업 순서

원본은 GitHub 공개 저장소 `sentaro757/sports-predictor` 의 `main` 이다. 여러 PC 에서 작업한다.

1. 시작 전: `git status` 로 커밋 안 한 변경이 있는지 본다. 있으면 손대지 말고 사용자에게 알린다.
   그다음 `git pull --rebase` 로 다른 PC·다른 AI 의 작업을 받는다.
2. `WORKLOG.md` 맨 위 몇 개를 읽어 직전 작업과 남은 일을 파악한다.
3. 작업한다. 주변 코드와 같은 말투·형식으로 (주석은 한국어, 짧게).
4. 끝나면: `npm test` 통과 → `WORKLOG.md` 맨 위에 기록 추가 → 커밋 → `git push`.
   push 가 거절되면 `git pull --rebase` 후 충돌을 풀고 테스트를 다시 돌린 뒤 push. 강제 push(`--force`)는 하지 않는다.
5. 사용자에게 **직접 확인할 방법**(주소와 볼 곳)을 알려준다. 집 PC 가 아닌 곳에서 작업했다면
   "집 PC에서 `git pull` 후 서버를 다시 켜야 반영된다(인터넷 주소도 바뀜)"고 안내한다.

한 번에 한 AI 만 작업한다. 사용자가 둘에게 동시에 일을 줬다면 서로 다른 파일만 건드리거나 브랜치를 나눈다.
실제 서비스용 서버(`npm run phone`)는 집 PC 에서만 켠다.

## 역할과 검토 흐름

- 개발 = Claude, 검토 = Codex.
- Codex 는 검토만 하고 코드는 고치지 않는다. 검토 결과를 `WORKLOG.md` 맨 위에 기록한다
  (재현 방법, 파일:줄, 심각도 P1/P2/P3 또는 치명/중요/개선, "Claude 에게" 요청).
- 사용자가 Claude 에게 "검토사항 왔어"라고 하면: `git pull --rebase` → WORKLOG.md 의 최신 Codex 기록을 읽고 항목별로 확인 →
  재현 사례를 `test/review.test.js` 에 회귀 테스트로 넣고 수정 → WORKLOG.md 에 조치 기록 → push.
- 2026-10-11 까지의 검토(1~3차, C1·S1~S10·I1~I5·R1~R12)와 조치 결과는 `REVIEW.md` 에 있다. 이후는 WORKLOG.md 에 쓴다.

## 지켜야 할 것

- **`data/state/`, `data/cache/`, `test/fixtures/*.local.json` 은 절대 커밋하지 않는다.**
  data/state 는 비밀번호 해시·로그인 세션·QR 토큰·AI 비용 기록·AI 호출 한도·부상 추적(집 PC에만 있는 실제 값).
  *.local.json 은 실제 기사 원문(저작권)이 든 평가 세트. `.gitignore` 를 지우거나 줄이지 않는다.
- **비용·보안 안전장치를 약하게 만들지 않는다.** 바꾸려면 먼저 사용자에게 묻는다:
  AI 하루 한도(분석 30회·기사 분류 40회), 동시 실행 2건, AI 확률 보정 ±15%p, AI 는 버튼 누를 때만 실행,
  외부 접속은 비밀번호 세션 또는 QR 토큰 필수, 비밀번호 변경 시 모든 세션·QR 토큰 회수, 로그인 실패 잠금, Host/Origin 검사.
- 실제 유료 AI(ANTHROPIC_API_KEY) 호출로 시험하지 않는다. 모의 클라이언트(`_setClientForTest`)로 시험한다.
- 화면·로그·채팅에 토큰·비밀번호를 출력하지 않는다.
- 수집하는 사이트의 robots.txt·이용약관을 따른다(예: KBO 공식 사이트는 자동 수집 금지라 쓰지 않음).
  외부 API 형식은 추측하지 말고 실제 응답을 확인한다.
- 평가 수치를 좋게 보이려고 평가 세트에만 맞춘 규칙을 넣지 않는다. 새 규칙은 일반화 가능한 것만, 처음 보는 기사로 따로 확인한다.
- 커밋 메시지는 한국어로, 무엇을 왜 바꿨는지.

## 확정된 결정 (사용자가 정한 것 — 바꾸려면 먼저 사용자에게 묻는다)

**사용자**
- 개발 초보다. 설명은 쉬운 한국어로 하고, 선택지가 있으면 추천안을 먼저 준다.
- API 키·비밀번호는 채팅에 붙여넣게 하지 않는다.

**예측**
- 승률은 무료 통계모델(Elo + 홈 + 최근 폼 + 부상 + 뉴스 신호, 축구는 포아송)이 계산한다.
- 기사는 예측 계산에 쓰는 재료다. 화면은 경기·승률·예측 근거 중심.
- AI 분석은 경기 상세의 **"AI 분석 실행" 버튼을 누를 때만**: ① Haiku(`claude-haiku-5-5`)가 그 경기 두 팀 기사 분류 → ② Opus(`claude-opus-5-5`)가 분석.
  자동·일괄 AI 분석은 하지 않는다(사용자가 거절함). 비용은 화면에 실제 토큰 기준으로 표시한다.

**화면**
- 홈팀이 항상 위/왼쪽. 굵은 글씨 + "우세" 표시 = 예측 승리팀.
- 뉴스 탭은 언론 보도 / 구단 공식 뉴스(MLB 30개 구단 공식 RSS) / 국내 언론으로 나눈다.

**접속**
- 집 PC 에서 `npm run phone` 으로 켜 두고 Cloudflare 임시 터널(가입 없음)로 폰·다른 PC 가 접속한다.
  폰은 QR(토큰)로 비밀번호 없이, 다른 PC 는 비밀번호(아이디 없음)로 로그인. 주소가 바뀌면 사용자가 크롬 원격 데스크톱으로 집 PC에서 확인한다.
- GitHub Pages(정적 공개 페이지)·클라우드 배포·Tailscale 은 쓰지 않기로 했다.
- 포트 3000 은 사용자의 다른 프로젝트가 쓰는 경우가 있어 집 PC 에서는 보통 `PORT=3010`.

## 구조 요약

- `server.js` — HTTP 서버·API·접근 제어. 집 PC(localhost, Cloudflare 헤더 없음)는 로그인 없이, 그 외는 세션 또는 QR 토큰 필수.
  터널 요청은 소켓이 127.0.0.1 이므로 `cf-connecting-ip` 등 헤더와 Host 로 구분한다.
- `src/service.js` 리그별 데이터 취합·예측, `src/model.js` Elo·포아송·보정·백테스트(Elo+홈 기준)
- `src/sources/` naver.js(국내), espn.js(해외), feeds.js(구단 공식 RSS)
- `src/signals.js` 기사 키워드·부정문·대상 팀/선수 판단(규칙), `src/ai-tagger.js` Haiku 기사 분류, `src/ai.js` Opus 경기 분석
- `src/usage.js` 비용 기록, `src/limits.js` 하루 호출 한도(파일 잠금), `src/injury-tracker.js` 부상 에피소드·결장 경기 수,
  `src/store.js` data/state 저장소, `src/tunnel.js` Cloudflare 터널, `src/auth.js` 비밀번호 로그인
- `public/` 화면(바닐라 JS)

## 알려진 함정

- 정규식처럼 백슬래시가 들어가는 코드는 셸 heredoc 대신 파일 편집 도구로 고친다(셸에서 백슬래시가 깨진 적이 있음).
- 일부 샌드박스 환경에서는 `os.networkInterfaces()` 가 오류를 낸다. 서버는 빈 목록으로 처리하고 LAN 테스트는 건너뛴다.
