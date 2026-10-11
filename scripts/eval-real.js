// 실제 기사 검증 세트로 기사 대상 팀 판단 정확도 평가 (로컬 전용): node scripts/eval-real.js
// test/fixtures/*.local.json 은 기사 원문이 들어 있어 git에 올리지 않는다
import fs from 'node:fs';
import path from 'node:path';
import * as S from '../src/signals.js';
import { leagueData } from '../src/service.js';

const dir = path.join(import.meta.dirname, '..', 'test', 'fixtures');
// 팀 판단 평가라서 같은 팀·같은 종류는 한 번만 본다 (선수별 건수는 test/review.test.js 에서 따로 확인)
const key = (arr) => [...new Set(arr.map(([t, g]) => `${t}:${g}`))].sort().join(',');
const files = ['real-articles.local.json', 'holdout.local.json'].filter((f) => fs.existsSync(path.join(dir, f)));
if (!files.length) console.log('로컬 검증 세트가 없습니다');
for (const f of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let ok = 0;
  for (const c of fx.cases) {
    const d = await leagueData(c.league);
    const r = S.attribute({ title: c.title, summary: c.summary }, d.teams, c.espnTags, d.roster);
    const got = key(r.impacts.map((x) => [x.teamId, x.tag]));
    if (got === key(c.expect)) ok++;
    else console.log(`  ✖ [${c.league}] ${c.title.slice(0, 60)}\n     기대 [${key(c.expect)}]  결과 [${got}]`);
  }
  console.log(`${f}: ${ok}/${fx.cases.length} (${Math.round((ok / fx.cases.length) * 100)}%)\n`);
}
