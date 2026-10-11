// 최근 경기 복기: 끝난 경기를 "그 경기 전날까지의 결과만으로" 다시 예측해 실제 결과와 비교한다 (네트워크 필요)
//   node scripts/review-recent.js            최근 3일
//   node scripts/review-recent.js 7 epl nba  최근 7일, 리그 지정
// 다시 계산한 예측은 부상·뉴스 보정이 없다(Elo+홈+최근 폼). 화면에 냈던 예측이 기록돼 있으면(src/prediction-log.js)
// "기록" 줄에 그 예측(시작 직전 마지막 값)도 함께 보여주고 따로 집계한다
import { LEAGUES, MODEL } from '../src/config.js';
import { buildRatings, predictGame } from '../src/model.js';
import * as naver from '../src/sources/naver.js';
import * as espn from '../src/sources/espn.js';
import { readPredictionLog } from '../src/prediction-log.js';

const days = Number(process.argv[2]) || 3;
const only = process.argv.slice(3);
const now = Date.now();
const from = now - days * 86400e3;
const kstDay = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const pct = (x) => `${Math.round(x * 100)}%`;
const outcome = (g) => (g.homeScore > g.awayScore ? 'home' : g.homeScore < g.awayScore ? 'away' : 'draw');
const NO_SIGNAL = { net: 0 };

const total = { n: 0, hit: 0, loss: 0, homeHit: 0 };
const shown = { n: 0, hit: 0, loss: 0 }; // 화면에 냈던 예측(기록 있는 경기만)
const buckets = new Map(); // 확신도 구간 → { n, hit }

for (const league of LEAGUES.filter((l) => !only.length || only.includes(l.id))) {
  const src = league.source === 'naver' ? naver : espn;
  const warn = () => {};
  let history;
  try {
    history = await src.getHistory(league, warn);
  } catch (e) {
    console.log(`${league.name}: 수집 실패 (${e.message})`);
    continue;
  }
  const targets = history
    .filter((g) => g.status === 'final' && Date.parse(g.date) >= from && Date.parse(g.date) <= now)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (!targets.length) {
    console.log(`${league.name}: 최근 ${days}일 끝난 경기 없음`);
    continue;
  }
  const isSoccer = MODEL[league.sport].draws;
  const plog = readPredictionLog(league.id);
  // 같은 날 경기는 그날 0시(KST) 전까지의 결과로 만든 레이팅을 같이 쓴다
  const byDay = new Map();
  const rows = [];
  let n = 0;
  let hit = 0;
  for (const g of targets) {
    const day = kstDay(Date.parse(g.date));
    if (!byDay.has(day)) {
      const cut = Date.parse(`${day}T00:00:00+09:00`);
      byDay.set(day, buildRatings(history.filter((x) => Date.parse(x.date) < cut), league.sport));
    }
    const p = predictGame(g, league.sport, { model: byDay.get(day), injuries: { home: [], away: [] }, signals: { home: NO_SIGNAL, away: NO_SIGNAL } });
    const res = outcome(g);
    const ok = p.pick === res;
    // 야구 무승부는 2지선다 예측으로 맞힐 수 없으므로 집계에서 뺀다
    if (!isSoccer && res === 'draw') continue;
    n++;
    if (ok) hit++;
    total.n++;
    if (ok) total.hit++;
    if (res === 'home') total.homeHit++;
    total.loss += -Math.log(Math.max(p.probs[res], 1e-6));
    const b = p.confidence >= 0.7 ? '70%+' : p.confidence >= 0.6 ? '60~70%' : p.confidence >= 0.5 ? '50~60%' : '50% 미만(축구)';
    const bk = buckets.get(b) || { n: 0, hit: 0 };
    bk.n++;
    if (ok) bk.hit++;
    buckets.set(b, bk);
    const nameOf = (k) => (k === 'home' ? g.home.name : k === 'away' ? g.away.name : '무승부');
    const pickName = nameOf(p.pick);
    const rec = plog[g.id]?.last;
    if (rec) {
      shown.n++;
      if (rec.pick === res) shown.hit++;
      shown.loss += -Math.log(Math.max(rec.probs[res], 1e-6));
    }
    rows.push(
      `  ${ok ? '○' : '✖'} ${day} ${g.away.name} ${g.awayScore} @ ${g.home.name} ${g.homeScore}` +
        ` | 예측 ${pickName} ${pct(p.confidence)}${isSoccer ? ` (홈 ${pct(p.probs.home)} 무 ${pct(p.probs.draw)} 원정 ${pct(p.probs.away)})` : ''}` +
        `${g.preseason ? ' [시범]' : ''}${g.neutral ? ' [중립]' : ''}${p.newSeason ? ' [새 시즌 첫 경기]' : ''}` +
        (rec ? `\n      기록 ${rec.pick === res ? '○' : '✖'} 화면 예측 ${nameOf(rec.pick)} ${pct(rec.probs[rec.pick])} (부상 ${rec.adj.home.injury}/${rec.adj.away.injury}, 뉴스 ${rec.adj.home.news}/${rec.adj.away.news})` : ''),
    );
  }
  console.log(`\n${league.name}: ${hit}/${n} 적중 (${n ? pct(hit / n) : '-'})`);
  for (const r of rows) console.log(r);
}

console.log(`\n=== 전체: ${total.hit}/${total.n} 적중 (${total.n ? pct(total.hit / total.n) : '-'}), 평균 logloss ${(total.loss / (total.n || 1)).toFixed(3)}`);
console.log(`    참고: 무조건 홈팀 선택 시 ${total.homeHit}/${total.n}`);
if (shown.n) console.log(`    화면에 냈던 예측(기록된 ${shown.n}경기): ${shown.hit}/${shown.n} 적중 (${pct(shown.hit / shown.n)}), logloss ${(shown.loss / shown.n).toFixed(3)}`);
else console.log('    화면에 냈던 예측 기록 없음 (기록은 대시보드에서 리그를 연 뒤부터 쌓인다)');
for (const [b, v] of [...buckets].sort()) console.log(`    확신도 ${b}: ${v.hit}/${v.n} (${pct(v.hit / v.n)})`);
