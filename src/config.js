// 종목/리그 정의. source: 'naver' (국내 리그) | 'espn' (해외 리그)
// seasonStartMonth: 네이버는 시즌 정보를 주지 않으므로 KST 날짜로 시즌을 정한다 (이 달부터 새 시즌)
export const SPORTS = {
  baseball: { name: '야구', icon: '⚾' },
  soccer: { name: '축구', icon: '⚽' },
  basketball: { name: '농구', icon: '🏀' },
};

export const LEAGUES = [
  // 야구
  { id: 'kbo', sport: 'baseball', name: 'KBO', source: 'naver', upper: 'kbaseball', category: 'kbo', newsSection: 'kbaseball', seasonStartMonth: 1 },
  { id: 'mlb', sport: 'baseball', name: 'MLB', source: 'espn', path: 'baseball/mlb', newsSection: 'wbaseball' },
  // 축구
  { id: 'kleague', sport: 'soccer', name: 'K리그1', source: 'naver', upper: 'kfootball', category: 'kleague', newsSection: 'kfootball', seasonStartMonth: 1 },
  { id: 'epl', sport: 'soccer', name: '프리미어리그', source: 'espn', path: 'soccer/eng.1', newsSection: 'wfootball' },
  { id: 'laliga', sport: 'soccer', name: '라리가', source: 'espn', path: 'soccer/esp.1', newsSection: 'wfootball' },
  { id: 'bundesliga', sport: 'soccer', name: '분데스리가', source: 'espn', path: 'soccer/ger.1', newsSection: 'wfootball' },
  { id: 'seriea', sport: 'soccer', name: '세리에A', source: 'espn', path: 'soccer/ita.1', newsSection: 'wfootball' },
  { id: 'ligue1', sport: 'soccer', name: '리그1', source: 'espn', path: 'soccer/fra.1', newsSection: 'wfootball' },
  // 농구
  { id: 'kbl', sport: 'basketball', name: 'KBL', source: 'naver', upper: 'kbasketball', category: 'kbl', newsSection: 'basketball', seasonStartMonth: 8 },
  { id: 'nba', sport: 'basketball', name: 'NBA', source: 'espn', path: 'basketball/nba', newsSection: 'basketball' },
];

// 종목별 예측모델 파라미터 (Elo 기반)
//  k: 경기당 레이팅 변동폭, hfa: 홈 어드밴티지(Elo 점수), regress: 시즌 전환 시 평균회귀 비율
//  form: 최근 5경기 폼 보정 최대치, injury: 결장 선수 1명당 감점, newsWeight: 뉴스 신호 1건당 보정
//  newcomer: 두 번째 시즌부터 처음 등장한 팀(승격팀)의 시작 레이팅 = 1500 - newcomer
//  draws: true면 Elo 차이를 기대 득점으로 바꿔 포아송 분포로 승/무/패를 계산 (축구)
export const MODEL = {
  baseball: { k: 6, hfa: 24, regress: 0.33, form: 12, injury: 6, injuryCap: 30, newsWeight: 4, newsCap: 16, newcomer: 0, draws: false },
  soccer: { k: 20, hfa: 60, regress: 0.2, form: 20, injury: 10, injuryCap: 50, newsWeight: 6, newsCap: 24, newcomer: 100, draws: true },
  basketball: { k: 20, hfa: 70, regress: 0.25, form: 20, injury: 18, injuryCap: 70, newsWeight: 6, newsCap: 24, newcomer: 0, draws: false },
};

export const UPCOMING_DAYS = 7;
export const PORT = Number(process.env.PORT || 3000);
// 기본은 이 PC에서만 접속 가능. 같은 네트워크의 다른 기기에서 열려면 HOST=0.0.0.0 과 ACCESS_TOKEN 을 함께 설정
export const HOST = process.env.HOST || '127.0.0.1';
export const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
// AI 분석 비용 안전장치: 하루 최대 호출 수, 동시에 실행할 수 있는 분석 수
export const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 30);
export const AI_MAX_CONCURRENT = 2;
// AI가 통계 확률에서 바꿀 수 있는 최대 폭 (결과별, 0.15 = 15%p)
export const AI_MAX_SHIFT = 0.15;
// AI 기사 분류 (AI_TAG_ARTICLES=1 일 때만): 사용할 모델, 하루 최대 호출 수 (1회 = 기사 최대 30건)
export const AI_TAG_MODEL = process.env.AI_TAG_MODEL || process.env.AI_MODEL || 'claude-opus-5-5';
export const AI_TAG_DAILY_LIMIT = Number(process.env.AI_TAG_DAILY_LIMIT || 40);
export const AI_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';

export const leagueById = (id) => LEAGUES.find((l) => l.id === id);

/** KST 날짜 기준 시즌 연도 (네이버 리그용) */
export function seasonOfKst(league, iso) {
  const kst = new Date(Date.parse(iso) + 9 * 3600e3);
  const y = kst.getUTCFullYear();
  return kst.getUTCMonth() + 1 >= (league.seasonStartMonth || 1) ? y : y - 1;
}
