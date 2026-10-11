# CLAUDE.md — 작업 안내 (Claude용)

야구·축구·농구 10개 리그(KBO, MLB, K리그1, EPL, 라리가, 분데스리가, 세리에A, 리그1, KBL, NBA)의 일정·결과·뉴스·부상·이적을 모아 승부를 예측하는 Node.js 웹 대시보드. 의존성 최소(`@anthropic-ai/sdk`, `qrcode`), 프레임워크 없음. 사용자 안내와 구조는 README.md, 검토 이력은 REVIEW.md 참고.

## 사용자와 일하는 방식 (반드시 지킬 것)

- **대화는 한국어로.** 사용자는 개발자가 아니므로 쉬운 말로 설명한다.
- **작업이 끝나면 항상 커밋하고 GitHub(origin main)에 push한다.** 따로 묻지 않는다. 커밋 메시지 끝에 Co-Authored-By 줄을 붙인다.
- **작업이 끝나면 사용자가 직접 테스트할 수 있는 방법(주소)과 확인할 점을 알려준다.**
  - 집 PC 세션이면 서버를 띄우고 `http://localhost:3010` 과 현재 인터넷 주소를 준다.
  - 클라우드·다른 PC 세션이면 서버를 직접 띄워 줄 수 없으므로, "집 PC에서 `git pull` 후 서버를 다시 켜야 반영된다"고 안내한다 (아래 '집 PC 서버').
- **Codex 검토 흐름:** Codex 가 검토만 하고 REVIEW.md 에 항목(R1, R2 …)을 추가해 push 한다. 사용자가 "검토사항 왔어"라고 하면 `git pull` → REVIEW.md 의 새 항목을 하나씩 확인 → 재현 사례를 `test/review.test.js` 에 회귀 테스트로 넣고 수정 → REVIEW.md 끝에 "조치 결과" 표를 추가 → push.
- 유료 AI 호출(실제 ANTHROPIC_API_KEY 사용)은 사용자 허락 없이 하지 않는다. 테스트는 모의 클라이언트(`_setClientForTest`)로 한다.

## 실행·검증

```bash
npm install
npm test                       # 회귀 테스트 (node:test). 테스트는 SP_STATE_DIR 임시 폴더를 쓴다
npm run check                  # 10개 리그 실제 수집·예측 점검 (네트워크 필요)
node scripts/eval-attribution.js   # 기사 대상 팀 판단 평가 (31문장, 100% 유지)
npm start                      # 이 PC 전용 (127.0.0.1)
npm run phone                  # 폰·다른 PC용: 같은 와이파이 + Cloudflare 임시 터널 + 비밀번호 로그인
```

- 포트 3000 은 사용자의 다른 프로젝트가 쓰는 경우가 있어 보통 `PORT=3010` 으로 띄운다.
- `node scripts/eval-real.js` 는 실제 기사로 만든 로컬 평가 세트(`test/fixtures/*.local.json`)가 있어야 한다. 기사 원문(저작권) 때문에 git 에 없다 — 다른 PC에는 없을 수 있다.

## 집 PC 서버 (사용자의 실제 사용 환경)

- 집 PC(Windows)에서 `npm run phone` 으로 켜 두고, 폰·다른 PC는 Cloudflare 임시 터널 주소(`https://○○○.trycloudflare.com`)로 접속한다. 주소는 서버를 다시 켤 때마다 바뀐다(사용자는 크롬 원격 데스크톱으로 집 PC에 들어가 새 주소를 확인).
- `cloudflared` 는 집 PC에만 설치돼 있다.
- **`data/state/` 는 git 에 없다** (비밀번호 해시, 로그인 세션, QR 토큰, AI 비용 기록, AI 호출 한도, 부상 추적). 다른 PC에서 서버를 켜면 이 값들이 새로 생긴다 — 사용자의 실제 비밀번호·기록은 집 PC에만 있다. 이 폴더를 지우거나 덮어쓰지 말 것.
- 코드를 바꿔 push 해도 집 PC 서버는 자동으로 바뀌지 않는다. 집 PC에서 `git pull` 후 서버를 다시 켜야 한다(이때 터널 주소도 바뀜).

## 구조 요약

- `server.js` — HTTP 서버·API·접근 제어. 집 PC(localhost, Cloudflare 헤더 없음)는 로그인 없이, 그 외(와이파이·터널)는 비밀번호 세션 또는 QR 토큰 필수. 터널 요청은 소켓이 127.0.0.1 이므로 `cf-connecting-ip` 등 헤더와 Host 로 구분한다.
- `src/service.js` — 리그별 데이터 취합·예측. `src/model.js` — Elo, 축구 포아송(Dixon-Coles), 폼·부상·뉴스 보정, 백테스트(Elo+홈).
- `src/sources/` — naver.js(국내), espn.js(해외), feeds.js(MLB 30개 구단 공식 RSS 기본 제공 + data/team-feeds.json).
- `src/signals.js` — 기사 키워드·부정문·기사 대상 팀/선수 판단(규칙). `src/ai-tagger.js` — Haiku 기사 분류. `src/ai.js` — Opus 경기 분석(AI 분석 버튼 누를 때만: ① Haiku 기사 분류 → ② Opus 분석).
- `src/usage.js` 비용 기록, `src/limits.js` 하루 호출 한도(파일 잠금), `src/injury-tracker.js` 부상 에피소드·결장 경기 수, `src/store.js` data/state 저장소, `src/tunnel.js` Cloudflare 터널, `src/auth.js` 비밀번호 로그인.
- `public/` — 화면(바닐라 JS). 홈팀이 항상 위/왼쪽, 굵은 글씨 + "우세" = 예측 승리팀.

## 지켜온 원칙

- 수집하는 사이트의 robots.txt·이용약관을 존중한다 (예: KBO 공식 사이트는 자동 수집 금지라 쓰지 않음).
- 화면·로그에 토큰·비밀번호를 출력하지 않는다.
- 모델 수치를 좋게 보이게 하려고 평가 세트에 맞춘 규칙을 넣지 않는다. 새 규칙은 일반화 가능한 것만, 처음 보는 기사로 따로 확인한다.
- 정규식처럼 백슬래시가 들어가는 코드는 셸 heredoc 대신 파일 편집 도구로 고친다 (셸에서 백슬래시가 깨진 적이 있음).
