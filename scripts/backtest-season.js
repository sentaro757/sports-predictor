// 지난 시즌 백테스트: 시즌의 모든 경기를 "그 경기 날 0시(KST) 전까지의 결과만으로" 다시 예측해 실제 결과와 비교한다 (네트워크 필요)
//   node scripts/backtest-season.js              모든 리그, 지난 시즌
//   node scripts/backtest-season.js kbo epl      리그 지정
//   node scripts/backtest-season.js --current    이번 시즌(진행 중)
// 예측은 화면과 같은 predictGame 을 쓰되 부상·뉴스 보정은 뺀다(과거 시점 기록이 없음) → Elo+홈+최근 폼.
// 모델 값은 바꾸지 않는다. 결과 비교용으로 "무조건 홈팀" 기준선을 함께 낸다.
import { LEAGUES, MODEL } from '../src/config.js';
import { buildRatings, predictGame } from '../src/model.js';
import * as naver from '../src/sources/naver.js';
import * as espn from '../src/sources/espn.js';

const args = process.argv.slice(2);
const useCurrent = args.includes('--current');
const only = args.filter((a) => !a.startsWith('--'));
const kstDay = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-');
const outcome = (g) => (g.homeScore > g.awayScore ? 'home' : g.homeScore < g.awayScore ? 'away' : 'draw');
const OUTCOMES = ['home', 'draw', 'away'];
const NO_SIGNAL = { net: 0 };
const BUCKETS = ['50% 미만', '50~60%', '60~70%', '70% 이상'];
const bucketOf = (c) => (c >= 0.7 ? BUCKETS[3] : c >= 0.6 ? BUCKETS[2] : c >= 0.5 ? BUCKETS[1] : BUCKETS[0]);

const brier = (probs, res) => OUTCOMES.reduce((s, k) => s + (probs[k] - (k === res ? 1 : 0)) ** 2, 0);
const newStat = () => ({ n: 0, hit: 0, brier: 0, homeHit: 0, homeBrier: 0, draws: 0, buckets: Object.fromEntries(BUCKETS.map((b) => [b, { n: 0, hit: 0, conf: 0 }])) });
const add = (st, p, res, isSoccer) => {
  st.n++;
  if (p.pick === res) st.hit++;
  st.brier += brier(p.probs, res);
  // 기준선: 무조건 홈팀. 확률은 홈 어드밴티지만 있을 때(Elo 차이 0)의 값으로 둔다
  if (res === 'home') st.homeHit++;
  st.homeBrier += brier(p.evenProbs, res);
  if (res === 'draw') st.draws++;
  const b = st.buckets[bucketOf(p.confidence)];
  b.n++;
  b.conf += p.confidence;
  if (p.pick === res) b.hit++;
};

const rows = [];
const bySport = new Map();
const all = newStat();

for (const league of LEAGUES.filter((l) => !only.length || only.includes(l.id))) {
  const src = league.source === 'naver' ? naver : espn;
  let history;
  try {
    history = (await src.getHistory(league, () => {})).filter((g) => g.status === 'final' && !g.preseason);
  } catch (e) {
    console.log(`${league.name}: 수집 실패 (${e.message})`);
    continue;
  }
  // 시즌 고르기: 경기에 시즌 정보가 있으면 그걸로, 마지막 시즌 = 이번 시즌(진행 중일 수도), 그 앞 = 지난 시즌
  const seasons = [...new Set(history.map((g) => g.season).filter((s) => s != null))].sort((a, b) => a - b);
  if (seasons.length < 2 && !useCurrent) {
    console.log(`${league.name}: 지난 시즌 데이터가 없습니다 (받은 시즌: ${seasons.join(', ') || '없음'})`);
    continue;
  }
  const target = useCurrent ? seasons.at(-1) : seasons.at(-2);
  const games = history.filter((g) => g.season === target).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const priorCount = history.filter((g) => Date.parse(g.date) < Date.parse(games[0].date)).length;
  const isSoccer = MODEL[league.sport].draws;
  const st = newStat();
  let model = null;
  let modelDay = null;
  const t0 = Date.now();
  for (const g of games) {
    const day = kstDay(Date.parse(g.date));
    if (day !== modelDay) {
      const cut = Date.parse(`${day}T00:00:00+09:00`);
      model = buildRatings(history.filter((x) => Date.parse(x.date) < cut), league.sport);
      modelDay = day;
    }
    const ctx = { model, injuries: { home: [], away: [] }, signals: { home: NO_SIGNAL, away: NO_SIGNAL } };
    const p = predictGame(g, league.sport, ctx);
    const res = outcome(g);
    // 야구 무승부(KBO)는 2지선다로 맞힐 수 없어 뺀다
    if (!isSoccer && res === 'draw') continue;
    // "무조건 홈팀" 확률: Elo 차이 0, 홈 어드밴티지만
    const even = predictGame({ ...g, home: { id: '__even_h' }, away: { id: '__even_a' } }, league.sport, ctx).probs;
    const pr = { pick: p.pick, probs: p.probs, confidence: p.confidence, evenProbs: even };
    add(st, pr, res, isSoccer);
    add(all, pr, res, isSoccer);
    if (!bySport.has(league.sport)) bySport.set(league.sport, newStat());
    add(bySport.get(league.sport), pr, res, isSoccer);
  }
  rows.push({ league, season: target, st, priorCount, ms: Date.now() - t0, isSoccer });
}

if (!rows.length) {
  console.log('평가할 리그가 없습니다');
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n - [...String(s)].filter((c) => /[ㄱ-힝]/.test(c)).length);
const padL = (s, n) => String(s).padStart(n);
console.log(`\n=== 리그별 (${useCurrent ? '이번' : '지난'} 시즌, Elo+홈+폼, 부상·뉴스 제외) ===`);
console.log(`${pad('리그', 10)} ${pad('시즌', 6)} ${padL('경기', 5)} ${padL('적중률', 7)} ${padL('홈팀만', 7)} ${padL('차이', 7)} ${padL('브라이어', 8)} ${padL('홈팀만', 7)} ${padL('무승부', 6)} 참고`);
for (const { league, season, st, priorCount, isSoccer } of rows) {
  const acc = st.hit / st.n;
  const home = st.homeHit / st.n;
  const diff = acc - home;
  const note = [priorCount < 100 ? `이전 경기 ${priorCount}개뿐(초반 Elo 불안정)` : '', isSoccer ? '' : ''].filter(Boolean).join(', ');
  console.log(
    `${pad(league.name, 10)} ${pad(season, 6)} ${padL(st.n, 5)} ${padL(pct(acc), 7)} ${padL(pct(home), 7)} ${padL((diff >= 0 ? '+' : '') + pct(diff), 7)} ${padL((st.brier / st.n).toFixed(3), 8)} ${padL((st.homeBrier / st.n).toFixed(3), 7)} ${padL(isSoccer ? pct(st.draws / st.n) : '-', 6)} ${note}`,
  );
}
for (const [sport, st] of bySport) {
  console.log(`${pad(`[${sport}]`, 17)} ${padL(st.n, 5)} ${padL(pct(st.hit / st.n), 7)} ${padL(pct(st.homeHit / st.n), 7)} ${padL((st.hit / st.n - st.homeHit / st.n >= 0 ? '+' : '') + pct(st.hit / st.n - st.homeHit / st.n), 7)} ${padL((st.brier / st.n).toFixed(3), 8)} ${padL((st.homeBrier / st.n).toFixed(3), 7)}`);
}
console.log(`${pad('전체', 17)} ${padL(all.n, 5)} ${padL(pct(all.hit / all.n), 7)} ${padL(pct(all.homeHit / all.n), 7)} ${padL((all.hit / all.n - all.homeHit / all.n >= 0 ? '+' : '') + pct(all.hit / all.n - all.homeHit / all.n), 7)} ${padL((all.brier / all.n).toFixed(3), 8)} ${padL((all.homeBrier / all.n).toFixed(3), 7)}`);
console.log('  브라이어 점수: 낮을수록 좋음. 축구는 승/무/패 3개 합(0~2), 야구·농구는 승/패(0~2 중 실제로는 0~1 범위).');

console.log('\n=== 예측 확률 구간별 실제 적중률 (리그별) ===');
console.log(`${pad('리그', 10)} ${BUCKETS.map((b) => padL(b, 18)).join('')}`);
const cell = (b) => (b.n ? `${pct(b.hit / b.n)} (${b.n})` : '-');
for (const { league, st } of rows) console.log(`${pad(league.name, 10)} ${BUCKETS.map((b) => padL(cell(st.buckets[b]), 18)).join('')}`);
console.log(`${pad('전체', 10)} ${BUCKETS.map((b) => padL(cell(all.buckets[b]), 18)).join('')}`);
console.log('\n=== 전체: 구간별 평균 예측 확률 vs 실제 적중률 (비슷하면 확신도가 잘 맞는 것) ===');
for (const b of BUCKETS) {
  const v = all.buckets[b];
  if (v.n) console.log(`  ${pad(b, 10)} 경기 ${padL(v.n, 5)}  평균 예측 ${pct(v.conf / v.n)}  실제 적중 ${pct(v.hit / v.n)}`);
}
console.log('\n참고: 야구 예측에 선발투수는 반영되지 않는다(팀 단위 Elo). 50% 미만 구간은 축구에서 세 결과 중 1등 확률이 50%를 못 넘는 경기.');
