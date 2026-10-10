// ESPN 공개 API: MLB / NBA / 유럽 5대리그 일정·결과·뉴스·부상·이적
import { fetchCached } from '../http.js';
import { classify } from '../signals.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';

const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
const leagueSlug = (league) => league.path.split('/')[1]; // 'soccer/eng.1' -> 'eng.1'

function scoreOf(s) {
  const v = s == null ? NaN : typeof s === 'object' ? Number(s.value ?? s.displayValue) : Number(s);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function statusOf(st) {
  const t = st?.type || {};
  if (/POSTPONED|CANCELED|CANCELLED|ABANDONED/.test(t.name || '')) return 'cancelled';
  if (t.state === 'post' || t.completed) return 'final';
  if (t.state === 'in') return 'live';
  return 'scheduled';
}

// 시즌 구분: scoreboard 는 ev.season.type, 팀 일정은 ev.seasonType.type (1 = 시범경기)
const seasonTypeOf = (ev) => Number(ev.season?.type ?? ev.seasonType?.type ?? NaN);

function toGame(league, ev) {
  const c = ev.competitions?.[0];
  if (!c || !Array.isArray(c.competitors) || Number.isNaN(Date.parse(ev.date))) return null;
  // 다른 대회(컵대회 등) 경기는 제외. 리그 정보가 없는 응답(scoreboard)은 요청한 리그의 경기다
  if (ev.league?.slug && ev.league.slug !== leagueSlug(league)) return null;
  const side = (ha) => c.competitors.find((x) => x.homeAway === ha);
  const h = side('home');
  const a = side('away');
  if (!h?.team?.id || !a?.team?.id) return null;
  const team = (x) => ({
    id: String(x.team.id),
    name: String(x.team.displayName || x.team.name || x.team.id),
    logo: x.team.logo || x.team.logos?.[0]?.href,
  });
  const status = statusOf(c.status || ev.status);
  const homeScore = status === 'scheduled' ? null : scoreOf(h.score);
  const awayScore = status === 'scheduled' ? null : scoreOf(a.score);
  return {
    id: String(ev.id),
    league: league.id,
    date: ev.date,
    season: Number.isFinite(Number(ev.season?.year)) ? Number(ev.season.year) : null,
    preseason: seasonTypeOf(ev) === 1,
    status: status === 'final' && (homeScore == null || awayScore == null) ? 'unknown' : status,
    statusText: (c.status || ev.status)?.type?.shortDetail,
    home: team(h),
    away: team(a),
    homeScore,
    awayScore,
    neutral: !!c.neutralSite,
  };
}

export async function getTeams(league, warn) {
  const j = await fetchCached(`${SITE}/${league.path}/teams?limit=100`, { ttl: 86400, warn });
  const teams = (j.sports?.[0]?.leagues?.[0]?.teams || []).map(({ team: t }) => ({
    id: String(t.id),
    name: t.displayName,
    logo: t.logos?.[0]?.href,
    // 기사 속 위치를 찾는 용도. "City" 같은 짧고 겹치는 이름은 쓰지 않는다
    aliases: [...new Set([t.displayName, t.shortDisplayName].filter((s) => s && s.length >= 4))],
  }));
  if (!teams.length) throw new Error(`${league.name} 팀 목록을 받지 못했습니다`);
  return teams;
}

/** 오늘 기준 앞뒤 날짜의 scoreboard (ESPN 날짜는 미국 기준이라 하루씩 넉넉하게 요청) */
export async function getGames(league, from, to, warn) {
  const days = [];
  for (let d = new Date(from.getTime() - 86400e3); d <= new Date(to.getTime() + 86400e3); d = new Date(d.getTime() + 86400e3)) {
    days.push(ymd(d));
  }
  let failed = 0;
  const res = await Promise.all(
    days.map((d) =>
      fetchCached(`${SITE}/${league.path}/scoreboard?dates=${d}&limit=200`, { ttl: 300, warn }).catch(() => {
        failed++;
        return { events: [] };
      }),
    ),
  );
  if (failed) warn(`일정 ${days.length}일 중 ${failed}일 수집 실패`);
  const seen = new Set();
  return res
    .flatMap((j) => j.events || [])
    .map((ev) => toGame(league, ev))
    .filter((g) => g && !seen.has(g.id) && seen.add(g.id));
}

/**
 * 이번 시즌과 지난 시즌(축구는 두 시즌) 리그 경기 결과.
 * 현재 소속팀의 일정을 모은 뒤, 지난 시즌에만 있던 팀(강등팀)의 일정도 추가로 받아
 * 강등팀끼리의 경기까지 빠짐없이 모은다. 대회 구분은 이벤트의 리그 정보로 한다.
 */
export async function getHistory(league, warn) {
  const teams = await getTeams(league, warn);
  const first = await fetchCached(`${SITE}/${league.path}/teams/${teams[0].id}/schedule`, { ttl: 1800, warn });
  const season = Number(first.requestedSeason?.year || first.season?.year);
  if (!season) throw new Error(`${league.name} 시즌 정보를 받지 못했습니다`);
  // 야구/농구는 기본 응답이 현재 시즌 구분(시범/포스트시즌)만 주므로 정규시즌(2)·포스트시즌(3)을 명시
  const cur = league.sport === 'soccer' ? [['', 1800]] : [['?seasontype=2', 1800], ['?seasontype=3', 1800]];
  // 축구는 시즌당 경기 수가 적어 지난 두 시즌까지 받는다 (백테스트·확률 보정용 표본 확보)
  const prevSeasons = league.sport === 'soccer' ? [season - 1, season - 2] : [season - 1];
  const prev = prevSeasons.flatMap((y) =>
    league.sport === 'soccer'
      ? [[`?season=${y}`, 86400 * 7]]
      : [[`?season=${y}&seasontype=2`, 86400 * 7], [`?season=${y}&seasontype=3`, 86400 * 7]],
  );

  let requested = 0;
  let failed = 0;
  const fetchSchedules = (ids, variants) =>
    Promise.all(
      ids.flatMap((id) =>
        variants.map(([q, ttl]) => {
          requested++;
          return fetchCached(`${SITE}/${league.path}/teams/${id}/schedule${q}`, { ttl, warn }).catch(() => {
            failed++;
            return { events: [] };
          });
        }),
      ),
    );

  const currentIds = teams.map((t) => t.id);
  const res = await fetchSchedules(currentIds, [...cur, ...prev]);
  const events = res.flatMap((j) => j.events || []);

  // 지난 시즌 상대팀 중 지금은 리그에 없는 팀(강등팀)의 지난 시즌 일정
  const known = new Set(currentIds);
  const extra = new Set();
  for (const ev of events) {
    if (!prevSeasons.includes(Number(ev.season?.year))) continue;
    for (const c of ev.competitions?.[0]?.competitors || []) {
      const id = String(c.team?.id);
      if (c.team?.id && !known.has(id)) extra.add(id);
    }
  }
  if (extra.size) events.push(...(await fetchSchedules([...extra], prev)).flatMap((j) => j.events || []));
  if (failed) warn(`팀 일정 ${requested}건 중 ${failed}건 수집 실패 — 일부 경기 결과가 빠졌을 수 있음`);

  const seen = new Set();
  let invalid = 0;
  const games = [];
  for (const ev of events) {
    if (seasonTypeOf(ev) === 1) continue; // 시범경기 제외
    const g = toGame(league, ev);
    if (!g) continue;
    if (g.status === 'unknown') invalid++;
    if (!seen.has(g.id)) {
      seen.add(g.id);
      games.push(g);
    }
  }
  if (invalid) warn(`점수가 비정상인 완료 경기 ${invalid}건 제외`);
  return games;
}

export async function getNews(league, warn) {
  const j = await fetchCached(`${SITE}/${league.path}/news?limit=60`, { ttl: 600, warn });
  return (j.articles || [])
    .filter((a) => a.headline)
    .map((a) => ({
      title: String(a.headline).slice(0, 200),
      summary: String(a.description || '').slice(0, 220),
      url: a.links?.web?.href,
      source: 'ESPN',
      date: a.published,
      image: a.images?.[0]?.url || null,
      lang: 'en',
      // ESPN이 직접 붙인 팀 태그 (이름 문자열 매칭보다 정확)
      teamIds: (a.categories || []).filter((c) => c.type === 'team' && (c.teamId ?? c.team?.id) != null).map((c) => String(c.teamId ?? c.team.id)),
      tags: classify(`${a.headline} ${a.description || ''}`),
    }));
}

export async function getInjuries(league, warn) {
  const j = await fetchCached(`${SITE}/${league.path}/injuries`, { ttl: 1800, warn }).catch((e) => {
    warn(`부상 명단 수집 실패: ${e.message}`);
    return null;
  });
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
      date: i.date, // 발병일이 아니라 마지막 업데이트 시각
      returnDate: i.details?.returnDate || null,
    })),
  );
}

export async function getTransactions(league, warn) {
  const j = await fetchCached(`${SITE}/${league.path}/transactions?limit=100`, { ttl: 1800, warn }).catch(() => null);
  if (!j?.transactions?.length) return null;
  return j.transactions.map((t) => ({
    teamId: String(t.team?.id),
    teamName: t.team?.displayName,
    date: t.date,
    description: t.description,
    tags: classify(t.description),
  }));
}
