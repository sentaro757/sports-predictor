// 모든 리그의 수집·예측이 동작하는지 점검: npm run check
import { LEAGUES } from '../src/config.js';
import { leagueOverview } from '../src/service.js';

const pct = (x) => `${Math.round(x * 100)}%`;
for (const l of LEAGUES) {
  const t = Date.now();
  try {
    const o = await leagueOverview(l.id);
    const bt = o.backtest ? `${o.backtest.label} 적중률 ${pct(o.backtest.accuracy)} (${o.backtest.games}경기)` : '백테스트 없음';
    console.log(
      `${l.name.padEnd(8)} 결과 ${o.gamesUsed}경기 | 예정 ${o.games.length} | 뉴스 ${o.news.length} | 부상 ${o.injuries.length}${o.injuriesStructured ? '' : '(기사)'} | 이적 ${o.transactions.length}${o.transactionsStructured ? '' : '(기사)'} | ${bt} | ${Date.now() - t}ms`,
    );
    const g = o.games[0];
    if (g) {
      const p = g.prediction.probs;
      console.log(`   예) ${g.away.name} @ ${g.home.name}: 홈 ${pct(p.home)} / 무 ${pct(p.draw)} / 원정 ${pct(p.away)}`);
    }
  } catch (e) {
    console.log(`${l.name.padEnd(8)} 실패: ${e.message}`);
  }
}
