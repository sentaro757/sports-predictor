import { LEAGUES, SPORTS, UPCOMING_DAYS, leagueById } from './config.js';
import { memo } from './http.js';
import { cachedTags, taggerEnabled } from './ai-tagger.js';
import { buildRatings, predictGame } from './model.js';
import { attribute, buildRosterIndex, teamNewsSignal } from './signals.js';
import * as naver from './sources/naver.js';
import * as espn from './sources/espn.js';
import { getTeamFeedNews } from './sources/feeds.js';
import { annotateInjuries } from './injury-tracker.js';

const src = (league) => (league.source === 'naver' ? naver : espn);
const byDateDesc = (a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0);
const IMPACT_TAGS = new Set(['injury', 'return', 'coach']);
const LIVE_GRACE_MS = 6 * 3600e3; // 시작 후 6시간까지는 진행 중 경기로 목록에 남긴다

function requireLeague(id) {
  const l = leagueById(id);
  if (!l) throw Object.assign(new Error(`알 수 없는 리그: ${id}`), { status: 404 });
  return l;
}

/** 해외 리그용 국내 언론 기사(해외야구/해외축구/농구 섹션) — 팀 매칭 없이 리그 뉴스로만 노출 */
async function koreanNewsFor(league, warn) {
  if (league.source === 'naver') return [];
  return naver.getNews({ newsSection: league.newsSection }, warn).catch(() => []);
}

/** 리그 단위로 모든 데이터를 모으고 Elo를 계산한다 (10분 캐시) */
export function leagueData(leagueId) {
  const league = requireLeague(leagueId);
  return memo(`league:${leagueId}`, 600, async () => {
    const warnings = new Set();
    const warn = (m) => warnings.add(m);
    const s = src(league);
    const now = Date.now();
    const from = new Date(now - 86400e3);
    const to = new Date(now + (UPCOMING_DAYS + 1) * 86400e3);

    // 일정·결과는 핵심 데이터라 실패하면 예외를 그대로 올린다. 나머지는 경고만 남긴다
    const [history, rawUpcoming, news, injuries, transactions, feedNews, koNews] = await Promise.all([
      s.getHistory(league, warn),
      s.getGames(league, from, to, warn),
      s.getNews(league, warn).catch((e) => (warn(`뉴스 수집 실패: ${e.message}`), [])),
      s.getInjuries(league, warn).catch(() => null),
      s.getTransactions(league, warn).catch(() => null),
      getTeamFeedNews(league.id),
      koreanNewsFor(league, warn),
    ]);
    if (!history.length) warn('과거 경기 결과가 없습니다 — 예측이 모두 50:50에 가깝게 나옵니다');

    // 요청은 날짜 단위로 넉넉하게 했으므로 실제 시각으로 다시 거른다
    const upcoming = rawUpcoming.filter((g) => {
      const t = Date.parse(g.date);
      return t >= now - LIVE_GRACE_MS && t <= now + UPCOMING_DAYS * 86400e3;
    });

    const teams = league.source === 'naver' ? naver.teamsFromGames([...history, ...upcoming]) : await espn.getTeams(league, warn);
    const teamMap = new Map(teams.map((t) => [t.id, t]));
    // 선수 이름 → 소속팀 사전 (기사 대상 팀 판단의 가장 강한 근거)
    const roster = buildRosterIndex(await s.getRoster(league, teams, warn).catch((e) => (warn(`선수 명단 수집 실패: ${e.message}`), [])));

    // 기사 ↔ 팀: 언급된 팀(teamIds)과 전력 신호의 대상 팀(impacts)을 따로 구한다
    // AI 기사 분류 결과가 있으면 그것을 쓰고, 없으면 규칙 기반 판단을 쓴다
    const articles = [...feedNews, ...news].map((a) => {
      const rule = attribute(a, teams, (a.teamIds || []).filter((id) => teamMap.has(id)), roster);
      const ai = cachedTags(league.id, a);
      const ids = new Set([...rule.teamIds, ...(ai?.events || []).map((e) => e.teamId)]);
      // 선수 정보도 넘긴다 (같은 선수의 같은 사건을 여러 기사가 다뤄도 1건으로 세기 위해)
      const impacts = ai
        ? ai.events.filter((e) => IMPACT_TAGS.has(e.tag)).map(({ teamId, tag, player }) => ({ teamId, tag, player: player || null }))
        : rule.impacts;
      const tags = ai ? [...new Set([...rule.tags.filter((t) => !IMPACT_TAGS.has(t)), ...ai.events.map((e) => e.tag)])] : rule.tags;
      return {
        ...a,
        tags,
        teamIds: [...ids].filter((id) => teamMap.has(id)),
        impacts: impacts.filter((x) => teamMap.has(x.teamId)),
        by: ai ? 'ai' : 'rule',
      };
    });
    articles.sort(byDateDesc);
    // AI 기사 분류는 자동으로 하지 않는다 (경기 상세의 AI 분석 버튼을 누를 때만, src/ai.js)
    const aiCount = articles.filter((a) => a.by === 'ai').length;
    const tagging = { enabled: taggerEnabled(), ai: aiCount, rule: articles.length - aiCount };

    const model = buildRatings(history, league.sport);
    // 현재 시즌에 뛰는 팀 (강등팀은 순위표에서 제외)
    const activeIds = new Set(
      [...history.filter((g) => g.season === model.lastSeason), ...upcoming].flatMap((g) => [g.home.id, g.away.id]),
    );
    return {
      league,
      teams,
      teamMap,
      roster,
      activeIds,
      history,
      upcoming,
      articles,
      koNews: koNews.sort(byDateDesc),
      // null 이면 구조화 데이터 없음(국내 리그, 유럽 축구). 있으면 결장 시작 시점·결장 경기 수를 붙인다
      injuries: injuries && annotateInjuries(league.id, injuries, history),
      transactions,
      model,
      warnings: [...warnings],
      tagging,
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
  // 이 팀이 부상/복귀 신호의 대상인 기사만
  const injuryNews = data.articles.filter((a) =>
    a.impacts.some((x) => x.teamId === teamId && (x.tag === 'injury' || x.tag === 'return')),
  );
  const signal = teamNewsSignal(data.articles, teamId, { ignoreInjury: !!data.injuries });
  return { articles, injuries, injuryNews, transactions, signal };
}

function predict(data, game) {
  const h = teamContext(data, game.home.id);
  const a = teamContext(data, game.away.id);
  const prediction = predictGame(game, data.league.sport, {
    model: data.model,
    injuries: { home: h.injuries, away: a.injuries },
    signals: { home: h.signal, away: a.signal },
  });
  return { prediction, ctx: { home: h, away: a } };
}

const slimTeam = (data, t) => ({ ...t, logo: t.logo || data.teamMap.get(t.id)?.logo });
const alertCount = (data, c) => (data.injuries ? c.injuries.length : c.injuryNews.length);

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
        alerts: { home: alertCount(data, ctx.home), away: alertCount(data, ctx.away) },
      };
    });

  const results = data.history
    .filter((g) => g.status === 'final')
    .sort(byDateDesc)
    .slice(0, 15);

  const rankings = [...data.model.ratings.entries()]
    .filter(([id]) => data.teamMap.has(id) && data.activeIds.has(id))
    .map(([id, elo]) => {
      const t = data.teamMap.get(id);
      return { id, name: t.name, logo: t.logo, elo: Math.round(elo), form: (data.model.recent.get(id) || []).slice(-5) };
    })
    .sort((a, b) => b.elo - a.elo);

  // 백테스트 라벨은 "지금 진행 중인(또는 다가오는) 시즌" 기준으로 붙인다
  const currentSeason = Math.max(data.model.lastSeason ?? -Infinity, ...data.upcoming.map((g) => g.season ?? -Infinity));
  const backtest = data.model.backtest && {
    ...data.model.backtest,
    label: data.model.backtest.season === currentSeason ? '이번 시즌' : '지난 시즌',
  };
  const injuryArticles = data.articles.filter((a) => a.impacts.some((x) => x.tag === 'injury' || x.tag === 'return'));
  return {
    league: data.league,
    updatedAt: data.updatedAt,
    warnings: data.warnings,
    tagging: data.tagging,
    backtest,
    soccerParams: data.model.soccer,
    gamesUsed: data.model.gamesUsed,
    games,
    results,
    rankings,
    news: data.articles.slice(0, 60),
    koNews: data.koNews.slice(0, 40),
    injuries: data.injuries ? data.injuries.slice().sort(byDateDesc).slice(0, 150) : injuryArticles.slice(0, 60),
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
