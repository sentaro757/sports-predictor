// ESPN 공개 API: MLB / NBA / 유럽 5대리그 일정·결과·뉴스·부상·이적
import { fetchCached } from '../http.js';
import { classify } from '../signals.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';

const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
const scoreOf = (s) => (s == null ? null : typeof s === 'object' ? Number(s.value ?? s.displayValue) : Number(s));

function statusOf(st) {
  const t = st?.type || {};
  if (/POSTPONED|CANCELED|CANCELLED|ABANDONED/.test(t.name || '')) return 'cancelled';
  if (t.state === 'post' || t.completed) return 'final';
  if (t.state === 'in') return 'live';
  return 'scheduled';
}

function toGame(league, ev) {
  const c = ev.competitions?.[0];
  if (!c) return null;
  const side = (ha) => c.competitors.find((x) => x.homeAway === ha);
  const h = side('home');
  const a = side('away');
  if (!h || !a) return null;
  const team = (x) => ({
    id: String(x.team.id),
    name: x.team.displayName,
    logo: x.team.logo || x.team.logos?.[0]?.href,
  });
  const status = statusOf(c.status || ev.status);
  return {
    id: String(ev.id),
    league: league.id,
    date: ev.date,
    status,
    statusText: (c.status || ev.status)?.type?.shortDetail,
    home: team(h),
    away: team(a),
    homeScore: status === 'scheduled' ? null : scoreOf(h.score),
    awayScore: status === 'scheduled' ? null : scoreOf(a.score),
    neutral: !!c.neutralSite,
  };
}

export async function getTeams(league) {
  const j = await fetchCached(`${SITE}/${league.path}/teams?limit=100`, { ttl: 86400 });
  const teams = j.sports?.[0]?.leagues?.[0]?.teams || [];
  return teams.map(({ team: t }) => ({
    id: String(t.id),
    name: t.displayName,
    logo: t.logos?.[0]?.href,
    aliases: [...new Set([t.displayName, t.shortDisplayName, t.name, t.nickname].filter((s) => s && s.length >= 3))],
  }));
}

export async function getGames(league, from, to) {
  const days = [];
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400e3)) days.push(ymd(d));
  const res = await Promise.all(
    days.map((d) =>
      fetchCached(`${SITE}/${league.path}/scoreboard?dates=${d}&limit=200`, { ttl: 300 }).catch(() => ({ events: [] })),
    ),
  );
  const seen = new Set();
  return res
    .flatMap((j) => j.events || [])
    .map((ev) => toGame(league, ev))
    .filter((g) => g && !seen.has(g.id) && seen.add(g.id));
}

/** 리그 전 팀의 이번/지난 시즌 일정을 모아 결과 목록을 만든다 */
export async function getHistory(league) {
  const teams = await getTeams(league);
  const ids = new Set(teams.map((t) => t.id));
  const first = await fetchCached(`${SITE}/${league.path}/teams/${teams[0].id}/schedule`, { ttl: 1800 });
  const season = first.requestedSeason?.year || first.season?.year;
  // 야구/농구는 기본 응답이 현재 시즌 구분(시범/포스트시즌)만 주므로 정규시즌(2)·포스트시즌(3)을 명시해서 받는다
  const variants =
    league.sport === 'soccer'
      ? [['', 1800], [`?season=${season - 1}`, 86400 * 7]]
      : [
          ['?seasontype=2', 1800],
          ['?seasontype=3', 1800],
          [`?season=${season - 1}&seasontype=2`, 86400 * 7],
          [`?season=${season - 1}&seasontype=3`, 86400 * 7],
        ];
  const urls = teams.flatMap((t) => variants.map(([q, ttl]) => [`${SITE}/${league.path}/teams/${t.id}/schedule${q}`, ttl]));
  const res = await Promise.all(urls.map(([u, ttl]) => fetchCached(u, { ttl }).catch(() => ({ events: [] }))));
  const seen = new Set();
  return res
    .flatMap((j) => j.events || [])
    .filter((ev) => ev.seasonType?.type !== 1) // 시범경기 제외
    .map((ev) => toGame(league, ev))
    .filter((g) => g && ids.has(g.home.id) && ids.has(g.away.id) && !seen.has(g.id) && seen.add(g.id));
}

export async function getNews(league) {
  const j = await fetchCached(`${SITE}/${league.path}/news?limit=60`, { ttl: 600 });
  return (j.articles || []).map((a) => ({
    title: a.headline,
    summary: (a.description || '').slice(0, 220),
    url: a.links?.web?.href,
    source: 'ESPN',
    date: a.published,
    image: a.images?.[0]?.url || null,
    lang: 'en',
    teamIds: (a.categories || []).filter((c) => c.type === 'team').map((c) => String(c.teamId ?? c.team?.id)),
    tags: classify(`${a.headline} ${a.description}`),
  }));
}

export async function getInjuries(league) {
  const j = await fetchCached(`${SITE}/${league.path}/injuries`, { ttl: 1800 }).catch(() => null);
  // 유럽 축구처럼 데이터가 비어 있으면 null → 뉴스 기사에서 추출하는 방식으로 대체
  if (!j?.injuries?.length) return null;
  return j.injuries.flatMap((t) =>
    (t.injuries || []).map((i) => ({
      teamId: String(t.id),
      teamName: t.displayName,
      player: i.athlete?.displayName,
      position: i.athlete?.position?.abbreviation,
      status: i.status,
      detail: i.shortComment || i.longComment || '',
      date: i.date,
    })),
  );
}

export async function getTransactions(league) {
  const j = await fetchCached(`${SITE}/${league.path}/transactions?limit=100`, { ttl: 1800 }).catch(() => null);
  if (!j?.transactions?.length) return null;
  return j.transactions.map((t) => ({
    teamId: String(t.team?.id),
    teamName: t.team?.displayName,
    date: t.date,
    description: t.description,
    tags: classify(t.description),
  }));
}
