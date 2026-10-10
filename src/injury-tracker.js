// 부상 선수가 "언제부터" 빠졌는지 추적해서, 이미 결장한 경기 수(gamesMissed)를 붙인다.
// 이미 여러 경기를 빠졌다면 그 공백은 최근 성적(Elo)에 반영돼 있으므로 감점을 줄이고,
// 방금 생긴 부상(아직 결장 경기 없음)은 복귀 예정일이 멀더라도 전액 감점한다 (src/model.js injuryAdj).
//
// 결장 시작 시점 = min(이 프로그램이 처음 본 시각, ESPN 부상 정보의 업데이트 시각)
//  - ESPN date 는 발병일이 아니라 마지막 업데이트 시각이지만, 그때 이미 부상이었으므로 "적어도 그때부터"의 근거가 된다
//  - 처음 실행하면 기록이 없으므로 보수적으로(=덜 할인) 계산된다
import { readJson, withFileLock, writeJsonSync } from './store.js';

const FORGET_MS = 30 * 86400e3; // 명단에서 30일 동안 안 보이면 기록 삭제 (회복)

export function annotateInjuries(leagueId, injuries, history, now = Date.now()) {
  if (!injuries?.length) return injuries;
  const file = `injuries-${leagueId}.json`;
  let seen = {};
  try {
    seen = withFileLock(`injuries-${leagueId}`, () => {
      const s = readJson(file, {});
      for (const i of injuries) {
        const key = `${i.teamId}|${String(i.player || '').toLowerCase()}`;
        const updated = Date.parse(i.date);
        const first = Math.min(s[key]?.firstSeen ?? now, Number.isFinite(updated) ? updated : now, now);
        s[key] = { firstSeen: first, lastSeen: now };
      }
      for (const [k, v] of Object.entries(s)) if (now - v.lastSeen > FORGET_MS) delete s[k];
      writeJsonSync(file, s);
      return s;
    });
  } catch (e) {
    console.warn(`[injury] 기록 실패: ${e.message}`);
  }

  // 팀별 완료 경기 시각 (오름차순)
  const gamesByTeam = new Map();
  for (const g of history) {
    if (g.status !== 'final') continue;
    const t = Date.parse(g.date);
    for (const id of [g.home.id, g.away.id]) {
      if (!gamesByTeam.has(id)) gamesByTeam.set(id, []);
      gamesByTeam.get(id).push(t);
    }
  }
  return injuries.map((i) => {
    const rec = seen[`${i.teamId}|${String(i.player || '').toLowerCase()}`];
    const since = rec?.firstSeen ?? now;
    const gamesMissed = (gamesByTeam.get(i.teamId) || []).filter((t) => t > since && t <= now).length;
    return { ...i, outSince: new Date(since).toISOString(), gamesMissed };
  });
}
