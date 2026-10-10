// 네이버 스포츠: KBO / K리그1 / KBL 일정·결과·뉴스
import { fetchCached } from '../http.js';
import { classify } from '../signals.js';

const API = 'https://api-gw.sports.naver.com';

// 기사에서 팀을 찾기 위한 추가 별칭 (팀 약칭 → 별칭)
const EXTRA_ALIASES = {
  KIA: ['기아', '타이거즈'], 삼성: ['라이온즈'], LG: ['트윈스'], 두산: ['베어스'], KT: ['위즈'],
  SSG: ['랜더스'], 롯데: ['자이언츠'], 한화: ['이글스'], NC: ['다이노스'], 키움: ['히어로즈'],
  서울: ['FC서울', 'FC 서울'], 전북: ['전북현대', '전북 현대'], 울산: ['울산HD', '울산 HD'], 포항: ['스틸러스'],
  대전: ['대전하나', '대전 하나'], 제주: ['제주SK', '제주 SK'], 강원: ['강원FC'], 광주: ['광주FC'],
  수원FC: ['수원FC'], 김천: ['김천상무', '김천 상무'], 안양: ['FC안양', 'FC 안양'], 대구: ['대구FC'],
};

const ymd = (d) => d.toISOString().slice(0, 10);

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
  const team = (side) => ({
    id: g[`${side}TeamCode`],
    name: g[`${side}TeamName`],
    logo: g[`${side}TeamEmblemUrl`],
  });
  return {
    id: g.gameId,
    league: league.id,
    date: `${g.gameDateTime}+09:00`,
    status: statusOf(g),
    statusText: g.statusInfo,
    home: team('home'),
    away: team('away'),
    homeScore: g.homeTeamScore ?? null,
    awayScore: g.awayTeamScore ?? null,
    neutral: !!g.neutralGround,
  };
}

async function fetchRange(league, from, to, ttl) {
  const url =
    `${API}/schedule/games?fields=basic&upperCategoryId=${league.upper}&categoryId=${league.category}` +
    `&fromDate=${ymd(from)}&toDate=${ymd(to)}&size=1000`;
  const j = await fetchCached(url, { ttl });
  return (j.result?.games || []).map((g) => toGame(league, g));
}

export async function getGames(league, from, to) {
  return fetchRange(league, from, to, 300);
}

/** 최근 약 18개월 결과 (지난 시즌 포함 → Elo 초기값 안정화) */
export async function getHistory(league) {
  const now = new Date();
  const chunks = [];
  // 6개월 단위로 나눠 요청. 오래된 구간은 하루, 최근 구간은 10분 캐시
  for (let i = 2; i >= 0; i--) {
    const to = new Date(now.getTime() - i * 182 * 86400e3);
    const from = new Date(to.getTime() - 181 * 86400e3);
    chunks.push(fetchRange(league, from, to, i === 0 ? 600 : 86400));
  }
  const all = (await Promise.all(chunks)).flat();
  const seen = new Set();
  return all.filter((g) => !seen.has(g.id) && seen.add(g.id));
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

export async function getNews(league) {
  const pages = await Promise.all(
    [1, 2].map((p) =>
      fetchCached(`${API}/news/articles/${league.newsSection}?sort=latest&page=${p}&pageSize=100`, { ttl: 600 }).catch(
        () => null,
      ),
    ),
  );
  const list = pages.flatMap((j) => j?.result?.newsList || []);
  return list.map((n) => ({
    title: n.title,
    summary: (n.subContent || '').replace(/\s+/g, ' ').slice(0, 220),
    url: `https://m.sports.naver.com/${n.sportsSection || league.newsSection}/article/${n.oid}/${n.aid}`,
    source: n.sourceName,
    date: n.dateTime ? `${n.dateTime}+09:00` : null,
    image: n.thumbnail || null,
    lang: 'ko',
    tags: classify(`${n.title} ${n.subContent}`),
  }));
}

// 국내 리그는 공개된 구조화 부상/이적 데이터가 없어 뉴스에서 추출한다 (index.js에서 처리)
export async function getInjuries() {
  return null;
}
export async function getTransactions() {
  return null;
}
