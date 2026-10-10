// 승부 예측모델: Elo 레이팅 + 최근 폼 + 부상자 + 뉴스 신호
import { MODEL } from './config.js';

const BASE = 1500;
const FALLBACK_GAP_DAYS = 60; // 경기에 시즌 정보가 없을 때만: 이만큼 공백이면 새 시즌으로 간주
const WARMUP_DAYS = 10; // 시즌 초반은 레이팅이 불안정해 백테스트에서 제외

const expected = (diff) => 1 / (1 + 10 ** (-diff / 400));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const OUTCOMES = ['home', 'draw', 'away'];

/* ---------- 축구: Elo 차이 → 기대 득점 → 포아송 승/무/패 ---------- */

// 기본값: 경기당 총 2.7골, Elo 100점 차이 ≈ 0.3골 우위, 저득점 무승부 보정(rho) 없음
const SOCCER_DEFAULT = { total: 2.7, perElo: 0.003, rho: 0, fitted: false };
const MAX_GOALS = 10;

function poissonRow(lambda) {
  const row = [Math.exp(-lambda)];
  for (let k = 1; k <= MAX_GOALS; k++) row.push((row[k - 1] * lambda) / k);
  return row;
}

function soccerProbs(diff, sp) {
  const sup = diff * sp.perElo; // 홈팀 기대 득점 우위
  const lh = Math.max(0.15, (sp.total + sup) / 2);
  const la = Math.max(0.15, (sp.total - sup) / 2);
  const ph = poissonRow(lh);
  const pa = poissonRow(la);
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      let p = ph[i] * pa[j];
      // Dixon-Coles 저득점 보정: rho < 0 이면 0:0, 1:1 이 늘어난다
      if (i === 0 && j === 0) p *= 1 - lh * la * sp.rho;
      else if (i === 0 && j === 1) p *= 1 + lh * sp.rho;
      else if (i === 1 && j === 0) p *= 1 + la * sp.rho;
      else if (i === 1 && j === 1) p *= 1 - sp.rho;
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
    }
  }
  const sum = home + draw + away;
  return { home: home / sum, draw: draw / sum, away: away / sum };
}

/** Elo 차이(홈 기준, 홈 어드밴티지 포함) → 승/무/패 확률 */
export function probabilities(diff, sport, soccerParams = SOCCER_DEFAULT) {
  if (MODEL[sport].draws) return soccerProbs(diff, soccerParams);
  const we = expected(diff);
  return { home: we, draw: 0, away: 1 - we };
}

const logLoss = (pr, res) => -Math.log(Math.max(pr[res], 1e-6));

/** 경기 전 Elo 차이 기록으로 축구 확률 파라미터를 맞춘다 (로그 손실 최소화) */
function fitSoccer(records) {
  if (records.length < 150) return SOCCER_DEFAULT;
  const total = records.reduce((s, r) => s + r.goals, 0) / records.length;
  let best = null;
  for (let perElo = 0.0015; perElo <= 0.0151; perElo += 0.0005) {
    for (const rho of [0, -0.05, -0.1, -0.15]) {
      const sp = { total, perElo, rho };
      const loss = records.reduce((s, r) => s + logLoss(soccerProbs(r.diff, sp), r.res), 0);
      if (!best || loss < best.loss) best = { loss, sp };
    }
  }
  return { ...best.sp, perElo: Math.round(best.sp.perElo * 1e4) / 1e4, fitted: true, samples: records.length };
}

/* ---------- Elo 계산 ---------- */

const outcome = (g) => (g.homeScore > g.awayScore ? 'home' : g.homeScore < g.awayScore ? 'away' : 'draw');
const validScore = (x) => Number.isFinite(x) && x >= 0;

/**
 * 완료된 경기를 시간순으로 돌며 Elo를 계산한다.
 * 경기마다 "그 경기 직전 레이팅"의 Elo 차이를 기록해 두고 백테스트에 쓴다 (경기 결과는 기록 뒤에 반영).
 */
export function buildRatings(history, sport) {
  const p = MODEL[sport];
  const games = history
    .filter((g) => g.status === 'final' && validScore(g.homeScore) && validScore(g.awayScore) && !g.preseason)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  const ratings = new Map();
  const recent = new Map(); // teamId -> 최근 결과 ('W'|'D'|'L')
  const records = []; // { season, t, diff, res, goals, warm }
  let season = null;
  let seasonStart = null;
  let seasonIndex = -1;
  let lastT = null;

  const get = (id) => {
    if (!ratings.has(id)) ratings.set(id, seasonIndex > 0 ? BASE - p.newcomer : BASE); // 승격팀은 평균보다 낮게 시작
    return ratings.get(id);
  };

  for (const g of games) {
    const t = Date.parse(g.date);
    const newSeason =
      season === null || (g.season != null ? g.season !== season : t - lastT > FALLBACK_GAP_DAYS * 86400e3);
    if (newSeason) {
      if (season !== null) {
        for (const [id, r] of ratings) ratings.set(id, r - (r - BASE) * p.regress);
        recent.clear();
      }
      season = g.season ?? (season === null ? 0 : season + 1);
      seasonStart = t;
      seasonIndex++;
    }
    lastT = t;

    const rh = get(g.home.id);
    const ra = get(g.away.id);
    const diff = rh - ra + (g.neutral ? 0 : p.hfa);
    const res = outcome(g);
    records.push({
      season,
      seasonIndex,
      diff,
      res,
      goals: g.homeScore + g.awayScore,
      warm: t - seasonStart > WARMUP_DAYS * 86400e3,
    });

    const score = res === 'home' ? 1 : res === 'away' ? 0 : 0.5;
    const margin = Math.abs(g.homeScore - g.awayScore);
    const winnerDiff = res === 'home' ? diff : -diff;
    const mov = res === 'draw' ? 1 : Math.log(margin + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
    const delta = p.k * Math.max(mov, 0.5) * (score - expected(diff));
    ratings.set(g.home.id, rh + delta);
    ratings.set(g.away.id, ra - delta);

    const r = { home: res === 'home' ? 'W' : res === 'away' ? 'L' : 'D', away: res === 'away' ? 'W' : res === 'home' ? 'L' : 'D' };
    for (const side of ['home', 'away']) {
      const arr = recent.get(g[side].id) || [];
      arr.push(r[side]);
      recent.set(g[side].id, arr.slice(-10));
    }
  }

  const { backtest, soccer } = evaluate(records, sport);
  return { ratings, recent, lastSeason: season, seasonCount: seasonIndex + 1, backtest, soccer, gamesUsed: games.length };
}

/**
 * 백테스트: 경기 직전 Elo+홈 어드밴티지만으로 예측했을 때의 성적.
 * 축구 확률 파라미터는 "평가 대상 시즌 이전" 경기로만 맞춰서 평가 시즌의 결과를 미리 보지 않게 한다.
 * (폼·부상·뉴스 보정은 과거 시점의 기사/부상 기록이 없어 검증 대상에서 빠진다)
 */
function evaluate(records, sport) {
  // 첫 시즌은 모든 팀이 1500에서 시작해 의미가 없으므로 다른 시즌이 있으면 제외
  const usable = records.filter((r) => r.warm && (r.seasonIndex > 0 || !records.some((x) => x.seasonIndex > 0)));
  const bySeason = new Map();
  for (const r of usable) bySeason.set(r.seasonIndex, [...(bySeason.get(r.seasonIndex) || []), r]);
  const idx = [...bySeason.keys()].sort((a, b) => a - b);
  const lastIdx = idx.at(-1);
  let evalIdx = lastIdx;
  let label = '이번 시즌';
  if (lastIdx !== undefined && bySeason.get(lastIdx).length < 50 && idx.length > 1) {
    evalIdx = idx.at(-2);
    label = '지난 시즌';
  }

  const isSoccer = MODEL[sport].draws;
  const soccer = isSoccer ? fitSoccer(records.filter((r) => r.warm)) : null; // 실제 예측용: 모든 과거 경기
  if (evalIdx === undefined) return { backtest: null, soccer };

  const evalSet = bySeason.get(evalIdx);
  const sp = isSoccer ? fitSoccer(records.filter((r) => r.warm && r.seasonIndex < evalIdx)) : null;
  let correct = 0;
  let brier = 0;
  let loss = 0;
  for (const r of evalSet) {
    const pr = probabilities(r.diff, sport, sp || undefined);
    const pick = OUTCOMES.filter((k) => !(k === 'draw' && !isSoccer)).sort((a, b) => pr[b] - pr[a])[0];
    if (pick === r.res) correct++;
    brier += OUTCOMES.reduce((s, k) => s + (pr[k] - (k === r.res ? 1 : 0)) ** 2, 0);
    // 야구 무승부(KBO)는 2지선다 확률로 로그 손실을 낼 수 없어 0.5씩 나눠 계산
    loss += !isSoccer && r.res === 'draw' ? (logLoss(pr, 'home') + logLoss(pr, 'away')) / 2 : logLoss(pr, r.res);
  }
  const n = evalSet.length;
  return {
    soccer,
    backtest: {
      label,
      season: evalSet[0].season,
      method: 'Elo+홈',
      games: n,
      accuracy: correct / n,
      brier: brier / n,
      logLoss: loss / n,
      paramsFromPriorSeasons: isSoccer ? !!sp?.fitted : null,
    },
  };
}

/* ---------- 경기 예측 ---------- */

function formAdj(results, sport) {
  const last5 = (results || []).slice(-5);
  if (!last5.length) return 0;
  const pts = last5.reduce((s, r) => s + (r === 'W' ? 1 : r === 'D' ? 0.5 : 0), 0) / last5.length;
  return (pts - 0.5) * 2 * MODEL[sport].form;
}

/**
 * 부상자 감점. 같은 선수는 한 번만 센다.
 * 복귀 예정일이 3주 넘게 남은 장기 결장은 이미 최근 성적(Elo)에 반영됐다고 보고 가중치를 낮춘다.
 */
export function injuryAdj(injuries, sport) {
  const p = MODEL[sport];
  const seen = new Set();
  let pen = 0;
  for (const i of injuries || []) {
    const who = (i.player || '').toLowerCase();
    if (who && seen.has(who)) continue;
    seen.add(who);
    const s = (i.status || '').toLowerCase();
    let w = /\bout\b|injured list|\bil\b|suspend/.test(s) ? 1 : /day|questionable|doubt|gtd/.test(s) ? 0.5 : 0.33;
    const ret = i.returnDate ? Date.parse(i.returnDate) : NaN;
    if (Number.isFinite(ret) && ret - Date.now() > 21 * 86400e3) w *= 0.3;
    else if (/season|60-day/.test(`${s} ${i.detail || ''}`.toLowerCase())) w *= 0.3;
    pen += p.injury * w;
  }
  return -Math.min(pen, p.injuryCap);
}

function newsAdj(signal, sport) {
  const p = MODEL[sport];
  return clamp(signal.net * p.newsWeight, -p.newsCap, p.newsCap);
}

/** 새 시즌 첫 경기 전이면 지난 시즌 레이팅에 평균회귀를 적용하고 폼은 비운다 */
function seasonView(model, game, sport) {
  const newSeason = game.season != null && model.lastSeason != null && game.season !== model.lastSeason;
  const regress = MODEL[sport].regress;
  return {
    newSeason,
    elo: (id) => {
      const r = model.ratings.get(id) ?? BASE - (model.seasonCount > 0 ? MODEL[sport].newcomer : 0);
      return newSeason ? r - (r - BASE) * regress : r;
    },
    form: (id) => (newSeason ? [] : model.recent.get(id) || []),
  };
}

/**
 * 한 경기의 예측. ctx: { model, injuries: {home, away}, signals: {home, away} }
 */
export function predictGame(game, sport, ctx) {
  const p = MODEL[sport];
  const view = seasonView(ctx.model, game, sport);
  const sp = ctx.model.soccer || undefined;
  const side = (s) => {
    const id = game[s].id;
    const elo = view.elo(id);
    const form = view.form(id);
    const adj = {
      form: formAdj(form, sport),
      injury: injuryAdj(ctx.injuries[s], sport),
      news: newsAdj(ctx.signals[s], sport),
    };
    return { elo, form: form.slice(-5), adj, total: elo + adj.form + adj.injury + adj.news };
  };
  const home = side('home');
  const away = side('away');
  const hfa = game.neutral ? 0 : p.hfa;
  let probs = probabilities(home.total + hfa - away.total, sport, sp);
  const baseProbs = probabilities(home.elo + hfa - away.elo, sport, sp);
  // 시범경기는 주전 출전시간이 달라 전력 차이가 결과로 덜 이어지므로 50:50 쪽으로 절반 당긴다
  if (game.preseason) {
    const even = p.draws ? { home: 0.37, draw: 0.26, away: 0.37 } : { home: 0.5, draw: 0, away: 0.5 };
    probs = Object.fromEntries(OUTCOMES.map((k) => [k, (probs[k] + even[k]) / 2]));
  }
  const pick = OUTCOMES.filter((k) => p.draws || k !== 'draw').sort((a, b) => probs[b] - probs[a])[0];
  return { probs, baseProbs, pick, confidence: probs[pick], hfa, newSeason: view.newSeason, preseason: !!game.preseason, home, away };
}
