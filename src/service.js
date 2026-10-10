import { LEAGUES, SPORTS, UPCOMING_DAYS, leagueById } from './config.js';
import { memo } from './http.js';
import { buildRatings, predictGame } from './model.js';
import { mentions, teamNewsSignal } from './signals.js';
import * as naver from './sources/naver.js';
import * as espn from './sources/espn.js';
import { getTeamFeedNews } from './sources/feeds.js';

const src = (league) => (league.source === 'naver' ? naver : espn);
const byDateDesc = (a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0);

function requireLeague(id) {
  const l = leagueById(id);
  if (!l) throw Object.assign(new Error(`알 수 없는 리그: ${id}`), { status: 404 });
  return l;
}

/** 해외 리그용 국내 언론 기사(해외야구/해외축구/농구 섹션) — 팀 매칭 없이 리그 뉴스로만 노출 */
async function koreanNewsFor(league) {
  if (league.source === 'naver') return [];
  return naver.getNews({ newsSection: league.newsSection }).catch(() => []);
}

/** 리그 단위로 모든 데이터를 모으고 Elo를 계산한다 (10분 캐시) */
export function leagueData(leagueId) {
  const league = requireLeague(leagueId);
  return memo(`league:${leagueId}`, 600, async () => {
    const s = src(league);
    const now = new Date();
    const from = new Date(now.getTime() - 86400e3);
    const to = new Date(now.getTime() + UPCOMING_DAYS * 86400e3);

    const [history, upcoming, news, injuries, transactions, feedNews, koNews] = await Promise.all([
      s.getHistory(league),
      s.getGames(league, from, to),
      s.getNews(league).catch(() => []),
      s.getInjuries(league).catch(() => null),
      s.getTransactions(league).catch(() => null),
      getTeamFeedNews(league.id),
      koreanNewsFor(league),
    ]);

    const teams = league.source === 'naver' ? naver.teamsFromGames([...history, ...upcoming]) : await espn.getTeams(league);
    const teamMap = new Map(teams.map((t) => [t.id, t]));

    // 기사 ↔ 팀 매칭 (ESPN 기사는 태그된 팀 + 이름 매칭)
    const articles = [...feedNews, ...news].map((a) => {
      const ids = new Set(a.teamIds || []);
      for (const t of teams) if (mentions(`${a.title} ${a.summary}`, t.aliases)) ids.add(t.id);
      return { ...a, teamIds: [...ids].filter((id) => teamMap.has(id)) };
    });
    articles.sort(byDateDesc);

    const model = buildRatings(history, league.sport);
    return {
      league,
      teams,
      teamMap,
      history,
      upcoming,
      articles,
      koNews: koNews.sort(byDateDesc),
      injuries, // null 이면 구조화 데이터 없음(국내 리그)
      transactions,
      model,
      updatedAt: new Date().toISOString(),
    };
  });
}

function teamContext(data, teamId) {
  const articles = data.articles.filter((a) => a.teamIds.includes(teamId));
  const injuries = data.injuries ? data.injuries.filter((i) => i.teamId === teamId) : [];
  const transactions = data.transactions
    ? data.transactions.filter((t) => t.teamId === teamId)
    : articles.filter((a) => a.tags.includes('transfer') || a.tags.includes('release'));
  const injuryNews = articles.filter((a) => a.tags.includes('injury') || a.tags.includes('return'));
  return { articles, injuries, injuryNews, transactions, signal: teamNewsSignal(articles) };
}

function predict(data, game) {
  const h = teamContext(data, game.home.id);
  const a = teamContext(data, game.away.id);
  const prediction = predictGame(game, data.league.sport, {
    model: data.model,
    injuries: { home: h.injuries, away: a.injuries },
    signals: { home: h.signal, away: a.signal },
    structuredInjuries: !!data.injuries,
  });
  return { prediction, ctx: { home: h, away: a } };
}

const slimTeam = (data, t) => ({ ...t, logo: t.logo || data.teamMap.get(t.id)?.logo });

export async function leagueOverview(leagueId) {
  const data = await leagueData(leagueId);
  const games = data.upcoming
    .filter((g) => g.status === 'scheduled' || g.status === 'live')
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .map((g) => {
      const { prediction, ctx } = predict(data, g);
      return {
        ...g,
        home: slimTeam(data, g.home),
        away: slimTeam(data, g.away),
        prediction: { probs: prediction.probs, pick: prediction.pick, confidence: prediction.confidence },
        alerts: {
          home: ctx.home.injuries.length + ctx.home.injuryNews.length,
          away: ctx.away.injuries.length + ctx.away.injuryNews.length,
        },
      };
    });

  const results = data.history
    .filter((g) => g.status === 'final')
    .sort(byDateDesc)
    .slice(0, 15);

  const rankings = [...data.model.ratings.entries()]
    .filter(([id]) => data.teamMap.has(id))
    .map(([id, elo]) => ({ ...data.teamMap.get(id), aliases: undefined, elo: Math.round(elo), form: (data.model.recent.get(id) || []).slice(-5) }))
    .sort((a, b) => b.elo - a.elo);

  return {
    league: data.league,
    updatedAt: data.updatedAt,
    backtest: data.model.backtest,
    gamesUsed: data.model.gamesUsed,
    games,
    results,
    rankings,
    news: data.articles.slice(0, 60),
    koNews: data.koNews.slice(0, 40),
    injuries: data.injuries
      ? data.injuries.slice().sort(byDateDesc).slice(0, 150)
      : data.articles.filter((a) => a.tags.includes('injury') || a.tags.includes('return')).slice(0, 60),
    injuriesStructured: !!data.injuries,
    transactions: data.transactions
      ? data.transactions.slice().sort(byDateDesc).slice(0, 100)
      : data.articles.filter((a) => a.tags.includes('transfer') || a.tags.includes('release')).slice(0, 60),
    transactionsStructured: !!data.transactions,
  };
}

export async function gameDetail(leagueId, gameId) {
  const data = await leagueData(leagueId);
  const game = data.upcoming.find((g) => g.id === gameId);
  if (!game) throw Object.assign(new Error('경기를 찾을 수 없습니다'), { status: 404 });
  const { prediction, ctx } = predict(data, game);
  const h2h = data.history
    .filter(
      (g) =>
        g.status === 'final' &&
        ((g.home.id === game.home.id && g.away.id === game.away.id) || (g.home.id === game.away.id && g.away.id === game.home.id)),
    )
    .sort(byDateDesc)
    .slice(0, 6);
  const side = (s) => ({
    team: slimTeam(data, game[s]),
    news: ctx[s].articles.slice(0, 12),
    injuries: ctx[s].injuries,
    injuryNews: ctx[s].injuryNews.slice(0, 8),
    transactions: ctx[s].transactions.slice(0, 8),
    signal: { pos: ctx[s].signal.pos, neg: ctx[s].signal.neg },
  });
  return {
    league: data.league,
    game,
    prediction,
    h2h,
    home: side('home'),
    away: side('away'),
    injuriesStructured: !!data.injuries,
  };
}

export function catalog() {
  return Object.entries(SPORTS).map(([id, s]) => ({
    id,
    ...s,
    leagues: LEAGUES.filter((l) => l.sport === id).map(({ id, name, source }) => ({ id, name, source })),
  }));
}
