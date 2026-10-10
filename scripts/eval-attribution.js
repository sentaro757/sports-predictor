// 기사 대상 팀 판단 정확도 평가: node scripts/eval-attribution.js
import fs from 'node:fs';
import path from 'node:path';
import * as S from '../src/signals.js';

const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'test', 'fixtures', 'attribution.json'), 'utf8'));
const key = (arr) => arr.map(([t, g]) => `${t}:${g}`).sort().join(',');

export function evaluate({ verbose = false } = {}) {
  const roster = {};
  for (const lang of ['ko', 'en']) {
    const list = fx.roster[lang].map(([name, teamId]) => ({ name, teamId }));
    roster[lang] = S.buildRosterIndex ? S.buildRosterIndex(list) : null;
  }
  let ok = 0;
  const misses = [];
  for (const c of fx.cases) {
    const r = S.attribute({ title: c.text, summary: '' }, fx.teams[c.lang], [], roster[c.lang]);
    const got = key(r.impacts.map((x) => [x.teamId, x.tag]));
    if (got === key(c.expect)) ok++;
    else misses.push(`  ✖ ${c.text}\n     기대 [${key(c.expect)}]  결과 [${got}]`);
  }
  if (verbose) console.log(misses.join('\n'));
  return { ok, total: fx.cases.length };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { ok, total } = evaluate({ verbose: true });
  console.log(`\n정확도 ${ok}/${total} (${Math.round((ok / total) * 100)}%)`);
}
