// 종목/리그 정의. source: 'naver' (국내 리그) | 'espn' (해외 리그)
export const SPORTS = {
  baseball: { name: '야구', icon: '⚾' },
  soccer: { name: '축구', icon: '⚽' },
  basketball: { name: '농구', icon: '🏀' },
};

export const LEAGUES = [
  // 야구
  { id: 'kbo', sport: 'baseball', name: 'KBO', source: 'naver', upper: 'kbaseball', category: 'kbo', newsSection: 'kbaseball' },
  { id: 'mlb', sport: 'baseball', name: 'MLB', source: 'espn', path: 'baseball/mlb', newsSection: 'wbaseball' },
  // 축구
  { id: 'kleague', sport: 'soccer', name: 'K리그1', source: 'naver', upper: 'kfootball', category: 'kleague', newsSection: 'kfootball' },
  { id: 'epl', sport: 'soccer', name: '프리미어리그', source: 'espn', path: 'soccer/eng.1', newsSection: 'wfootball' },
  { id: 'laliga', sport: 'soccer', name: '라리가', source: 'espn', path: 'soccer/esp.1', newsSection: 'wfootball' },
  { id: 'bundesliga', sport: 'soccer', name: '분데스리가', source: 'espn', path: 'soccer/ger.1', newsSection: 'wfootball' },
  { id: 'seriea', sport: 'soccer', name: '세리에A', source: 'espn', path: 'soccer/ita.1', newsSection: 'wfootball' },
  { id: 'ligue1', sport: 'soccer', name: '리그1', source: 'espn', path: 'soccer/fra.1', newsSection: 'wfootball' },
  // 농구
  { id: 'kbl', sport: 'basketball', name: 'KBL', source: 'naver', upper: 'kbasketball', category: 'kbl', newsSection: 'basketball' },
  { id: 'nba', sport: 'basketball', name: 'NBA', source: 'espn', path: 'basketball/nba', newsSection: 'basketball' },
];

// 종목별 예측모델 파라미터 (Elo 기반)
//  k: 경기당 레이팅 변동폭, hfa: 홈 어드밴티지(Elo 점수), regress: 시즌 전환 시 평균회귀 비율
//  form: 최근 5경기 폼 보정 최대치, injury: 결장 선수 1명당 감점, newsWeight: 뉴스 신호 1건당 보정
export const MODEL = {
  baseball: { k: 6, hfa: 24, regress: 0.33, form: 12, injury: 6, injuryCap: 30, newsWeight: 4, newsCap: 16, draws: false },
  soccer: { k: 20, hfa: 60, regress: 0.2, form: 20, injury: 10, injuryCap: 50, newsWeight: 6, newsCap: 24, draws: true },
  basketball: { k: 20, hfa: 70, regress: 0.25, form: 20, injury: 18, injuryCap: 70, newsWeight: 6, newsCap: 24, draws: false },
};

export const UPCOMING_DAYS = 7;
export const PORT = Number(process.env.PORT || 3000);
export const AI_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';

export const leagueById = (id) => LEAGUES.find((l) => l.id === id);
