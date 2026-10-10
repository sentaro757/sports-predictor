// 승부 예측모델: Elo 레이팅 + 최근 폼 + 부상자 + 뉴스 신호
import { MODEL } from './config.js';

const BASE = 1500;
const OFFSEASON_GAP_DAYS = 45; // 이 이상 경기가 없으면 새 시즌으로 보고 평균회귀

const expected = (diff) => 1 / (1 + 10 ** (-diff / 400));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Elo 차이 → 승/무/패 확률 */
export function probabilities(diff, sport) {
  const we = expected(diff);
  if (!MODEL[sport].draws) return { home: we, draw: 0, away: 1 - we };
  // 축구: 전력 차가 작을수록 무승부 확률이 높다
  const draw = 0.28 * Math.exp(-((diff / 300) ** 2));
  let home = Math.max(0.02, we - draw / 2);
  let away = Math.max(0.02, 1 - we - draw / 2);
  const sum = home + draw + away;
  return { home: home / sum, draw: draw / sum, away: away / sum };
}

const outcome = (g) => (g.homeScore > g.awayScore ? 'home' : g.homeScore < g.awayScore ? 'away' : 'draw');

/**
 * 완료된 경기를 시간순으로 돌며 Elo를 계산한다.
 * 동시에 "경기 전 레이팅으로 예측했다면 맞혔을까"를 기록해 이번 시즌 적중률을 낸다.
 */
export function buildRatings(history, sport) {
  const p = MODEL[sport];
  const games = history
    .filter((g) => g.status === 'final' && g.homeScore != null && g.awayScore != null)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  const ratings = new Map();
  const recent = new Map(); // teamId -> 최근 결과 배열 ('W'|'D'|'L')
  const get = (id) => ratings.get(id) ?? BASE;
  let lastDate = null;
  let seasonStart = null;
  const newBt = (start) => ({ n: 0, correct: 0, brier: 0, start });
  const seasons = [];
  let bt = null;

  for (const g of games) {
    const t = Date.parse(g.date);
    if (lastDate && t - lastDate > OFFSEASON_GAP_DAYS * 86400e3) {
      for (const [id, r] of ratings) ratings.set(id, r - (r - BASE) * p.regress);
      for (const id of recent.keys()) recent.set(id, []);
      seasonStart = t;
      seasons.push((bt = newBt(t)));
    }
    if (!seasonStart) {
      seasonStart = t;
      seasons.push((bt = newBt(t)));
    }
    lastDate = t;

    const rh = get(g.home.id);
    const ra = get(g.away.id);
    const diff = rh - ra + (g.neutral ? 0 : p.hfa);
    const res = outcome(g);

    // 백테스트 (시즌 초반 10일은 레이팅이 불안정하므로 제외)
    if (t - seasonStart > 10 * 86400e3) {
      const pr = probabilities(diff, sport);
      const pick = Object.entries(pr).sort((a, b) => b[1] - a[1])[0][0];
      bt.n++;
      if (pick === res) bt.correct++;
      bt.brier += ['home', 'draw', 'away'].reduce((s, k) => s + (pr[k] - (k === res ? 1 : 0)) ** 2, 0);
    }

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

  return {
    ratings,
    recent,
    backtest: summarizeBacktest(seasons),
    gamesUsed: games.length,
  };
}

// 이번 시즌 표본이 적으면(50경기 미만) 지난 시즌 적중률을 함께 보여준다
function summarizeBacktest(seasons) {
  const fmt = (b, label) => (b?.n ? { label, games: b.n, accuracy: b.correct / b.n, brier: b.brier / b.n } : null);
  const cur = seasons.at(-1);
  if (cur?.n >= 50) return fmt(cur, '이번 시즌');
  return fmt(seasons.at(-2), '지난 시즌') || fmt(cur, '이번 시즌');
}

function formAdj(results, sport) {
  const last5 = (results || []).slice(-5);
  if (!last5.length) return 0;
  const pts = last5.reduce((s, r) => s + (r === 'W' ? 1 : r === 'D' ? 0.5 : 0), 0) / last5.length;
  return (pts - 0.5) * 2 * MODEL[sport].form;
}

function injuryAdj(injuries, sport) {
  const p = MODEL[sport];
  let pen = 0;
  for (const i of injuries || []) {
    const s = (i.status || '').toLowerCase();
    let w = /out|injured list|il|suspend/.test(s) ? 1 : /day|questionable|doubt/.test(s) ? 0.5 : 0.33;
    // 오래된 장기 부상은 이미 최근 경기 결과(Elo)에 반영되어 있으므로 가중치를 낮춘다
    if (i.date && Date.now() - Date.parse(i.date) > 21 * 86400e3) w *= 0.3;
    pen += p.injury * w;
  }
  return -Math.min(pen, p.injuryCap);
}

function newsAdj(signal, sport, hasStructuredInjuries) {
  const p = MODEL[sport];
  // 구조화된 부상 데이터가 있는 리그는 뉴스의 부상 신호를 절반만 반영(중복 방지)
  const w = hasStructuredInjuries ? p.newsWeight / 2 : p.newsWeight;
  return clamp(signal.net * w, -p.newsCap, p.newsCap);
}

/**
 * 한 경기의 예측. ctx: { model, injuries: {home, away}, signals: {home, away}, structuredInjuries }
 */
export function predictGame(game, sport, ctx) {
  const p = MODEL[sport];
  const side = (s) => {
    const id = game[s].id;
    const elo = ctx.model.ratings.get(id) ?? BASE;
    const form = ctx.model.recent.get(id) || [];
    const adj = {
      form: formAdj(form, sport),
      injury: injuryAdj(ctx.injuries[s], sport),
      news: newsAdj(ctx.signals[s], sport, ctx.structuredInjuries),
    };
    return { elo, form: form.slice(-5), adj, total: elo + adj.form + adj.injury + adj.news };
  };
  const home = side('home');
  const away = side('away');
  const hfa = game.neutral ? 0 : p.hfa;
  const diff = home.total + hfa - away.total;
  const probs = probabilities(diff, sport);
  const baseProbs = probabilities(home.elo + hfa - away.elo, sport);
  const pick = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
  return {
    probs,
    baseProbs,
    pick: pick[0],
    confidence: pick[1],
    hfa,
    home,
    away,
  };
}
