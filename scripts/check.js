// 모든 리그의 수집·예측이 동작하는지 점검: npm run check
// 리그 하나라도 실패하거나 과거 경기/예정 경기가 비면 종료 코드 1
import { LEAGUES } from '../src/config.js';
import { leagueOverview } from '../src/service.js';

const pct = (x) => `${Math.round(x * 100)}%`;
let failures = 0;
for (const l of LEAGUES) {
  const t = Date.now();
  try {
    const o = await leagueOverview(l.id);
    const b = o.backtest;
    const bt = b ? `${b.label} Elo+홈 적중률 ${pct(b.accuracy)} (${b.games}경기, logloss ${b.logLoss.toFixed(3)})` : '백테스트 없음';
    console.log(
      `${l.name.padEnd(8)} 결과 ${o.gamesUsed}경기 | 예정 ${o.games.length} | 뉴스 ${o.news.length} | 부상 ${o.injuries.length}${o.injuriesStructured ? '' : '(기사)'} | 이적 ${o.transactions.length}${o.transactionsStructured ? '' : '(기사)'} | ${bt} | ${Date.now() - t}ms`,
    );
    if (o.soccerParams?.fitted) {
      const s = o.soccerParams;
      console.log(`   축구 모델: 경기당 ${s.total.toFixed(2)}골, Elo 100점당 ${(s.perElo * 100).toFixed(2)}골, rho ${s.rho}`);
    }
    const g = o.games[0];
    if (g) {
      const p = g.prediction.probs;
      console.log(`   예) ${g.away.name} @ ${g.home.name}${g.preseason ? ' [시범]' : ''}: 홈 ${pct(p.home)} / 무 ${pct(p.draw)} / 원정 ${pct(p.away)}`);
    }
    for (const w of o.warnings) console.log(`   ⚠ ${w}`);
    if (!o.gamesUsed) {
      console.log('   ✖ 과거 경기 결과가 없습니다');
      failures++;
    }
  } catch (e) {
    console.log(`${l.name.padEnd(8)} ✖ 실패: ${e.message}`);
    failures++;
  }
}
if (failures) {
  console.log(`\n${failures}개 리그에 문제가 있습니다.`);
  process.exitCode = 1;
}
