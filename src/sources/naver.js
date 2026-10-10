// 네이버 스포츠: KBO / K리그1 / KBL 일정·결과·뉴스
import { fetchCached } from '../http.js';
import { classify } from '../signals.js';
import { seasonOfKst } from '../config.js';

const API = 'https://api-gw.sports.naver.com';

// 기사에서 팀을 찾기 위한 추가 별칭 (팀 약칭 → 별칭)
const EXTRA_ALIASES = {
  KIA: ['기아', '타이거즈'], 삼성: ['라이온즈'], LG: ['트윈스'], 두산: ['베어스'], KT: ['위즈'],
  SSG: ['랜더스'], 롯데: ['자이언츠'], 한화: ['이글스'], NC: ['다이노스'], 키움: ['히어로즈'],
  서울: ['FC서울', 'FC 서울'], 전북: ['전북현대', '전북 현대'], 울산: ['울산HD', '울산 HD'], 포항: ['스틸러스'],
  대전: ['대전하나', '대전 하나'], 제주: ['제주SK', '제주 SK'], 강원: ['강원FC'], 광주: ['광주FC'],
  수원FC: ['수원FC'], 김천: ['김천상무', '김천 상무'], 안양: ['FC안양', 'FC 안양'], 대구: ['대구FC'],
};

// 네이버는 한국 날짜(KST)로 조회한다
const ymd = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const scoreOf = (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null);

function statusOf(g) {
  if (g.cancel || g.statusCode === 'CANCEL') return 'cancelled';
  if (g.suspended) return 'suspended';
  if (g.statusCode === 'RESULT') return 'final';
  if (g.statusCode === 'BEFORE') return 'scheduled';
  return 'live';
}

function aliasesFor(name) {
  const parts = name.split(/\s+/);
  const short = parts[parts.length - 1]; // "서울 삼성" -> "삼성"
  return [...new Set([name, short, ...(EXTRA_ALIASES[short] || []), ...(EXTRA_ALIASES[name] || [])])];
}

function toGame(league, g) {
  if (!g.gameId || !g.homeTeamCode || !g.awayTeamCode) return null;
  // gameDateTime 은 시간대 표기가 없는 KST 시각. 이미 표기가 있으면 그대로 쓴다
  const date = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(g.gameDateTime || '') ? g.gameDateTime : `${g.gameDateTime}+09:00`;
  if (Number.isNaN(Date.parse(date))) return null;
  const team = (side) => ({
    id: String(g[`${side}TeamCode`]),
    name: String(g[`${side}TeamName`] || g[`${side}TeamCode`]),
    logo: g[`${side}TeamEmblemUrl`],
  });
  let status = statusOf(g);
  const homeScore = scoreOf(g.homeTeamScore);
  const awayScore = scoreOf(g.awayTeamScore);
  if (status === 'final' && (homeScore == null || awayScore == null)) status = 'unknown';
  return {
    id: String(g.gameId),
    league: league.id,
    date,
    season: seasonOfKst(league, date),
    preseason: false,
    status,
    statusText: g.statusInfo,
    home: team('home'),
    away: team('away'),
    homeScore,
    awayScore,
    neutral: !!g.neutralGround,
  };
}

async function fetchRange(league, from, to, ttl, warn) {
  const url =
    `${API}/schedule/games?fields=basic&upperCategoryId=${league.upper}&categoryId=${league.category}` +
    `&fromDate=${ymd(from)}&toDate=${ymd(to)}&size=1000`;
  const j = await fetchCached(url, { ttl, warn });
  if (!Array.isArray(j.result?.games)) throw new Error(`네이버 일정 응답 형식이 다릅니다 (${league.name})`);
  const games = j.result.games.map((g) => toGame(league, g)).filter(Boolean);
  if (j.result.gameTotalCount > j.result.games.length) warn?.(`일정 일부만 받음 (${j.result.games.length}/${j.result.gameTotalCount})`);
  return games;
}

export async function getGames(league, from, to, warn) {
  return fetchRange(league, from, to, 300, warn);
}

/** 최근 약 18개월 결과 (지난 시즌 포함 → Elo 초기값 안정화) */
export async function getHistory(league, warn) {
  const now = new Date();
  const chunks = [];
  // 6개월 단위로 나눠 요청. 오래된 구간은 하루, 최근 구간은 10분 캐시
  for (let i = 2; i >= 0; i--) {
    const to = new Date(now.getTime() - i * 182 * 86400e3);
    const from = new Date(to.getTime() - 181 * 86400e3);
    chunks.push(fetchRange(league, from, to, i === 0 ? 600 : 86400, warn));
  }
  const all = (await Promise.all(chunks)).flat();
  const seen = new Set();
  const games = all.filter((g) => !seen.has(g.id) && seen.add(g.id));
  const invalid = games.filter((g) => g.status === 'unknown').length;
  if (invalid) warn?.(`점수가 비정상인 완료 경기 ${invalid}건 제외`);
  return games;
}

export function teamsFromGames(games) {
  const map = new Map();
  for (const g of games) {
    for (const t of [g.home, g.away]) {
      if (!map.has(t.id)) map.set(t.id, { ...t, aliases: aliasesFor(t.name) });
    }
  }
  return [...map.values()];
}

export async function getNews(league, warn) {
  const pages = await Promise.all(
    [1, 2].map((p) =>
      fetchCached(`${API}/news/articles/${league.newsSection}?sort=latest&page=${p}&pageSize=100`, { ttl: 600, warn }).catch(
        (e) => {
          warn?.(`뉴스 ${p}페이지 수집 실패: ${e.message}`);
          return null;
        },
      ),
    ),
  );
  const list = pages.flatMap((j) => j?.result?.newsList || []);
  return list.filter((n) => n.title && n.oid && n.aid).map((n) => ({
    title: String(n.title).slice(0, 200),
    summary: (n.subContent || '').replace(/\s+/g, ' ').slice(0, 220),
    url: `https://m.sports.naver.com/${n.sportsSection || league.newsSection}/article/${n.oid}/${n.aid}`,
    source: n.sourceName,
    date: n.dateTime ? `${n.dateTime}+09:00` : null,
    image: n.thumbnail || null,
    lang: 'ko',
    tags: classify(`${n.title} ${n.subContent || ''}`),
  }));
}

// 국내 리그는 공개된 구조화 부상/이적 데이터가 없어 뉴스에서 추출한다 (service.js에서 처리)
export async function getInjuries() {
  return null;
}
export async function getTransactions() {
  return null;
}
