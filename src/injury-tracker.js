// 부상 선수가 "언제부터" 빠졌는지 추적해서, 이미 결장한 경기 수(gamesMissed)를 붙인다.
// 이미 여러 경기를 빠졌다면 그 공백은 최근 성적(Elo)에 반영돼 있으므로 감점을 줄이고,
// 방금 생긴 부상(아직 결장 경기 없음)은 복귀 예정일이 멀더라도 전액 감점한다 (src/model.js injuryAdj).
//
// 결장 시작 시점 = min(이 프로그램이 처음 본 시각, ESPN 부상 정보의 업데이트 시각)
//  - ESPN date 는 발병일이 아니라 마지막 업데이트 시각이지만, 그때 이미 부상이었으므로 "적어도 그때부터"의 근거가 된다
//  - 처음 실행하면 기록이 없으므로 보수적으로(=덜 할인) 계산된다
//
// 부상 "에피소드": 정상적으로 받은 명단에서 선수가 빠진 것을 본 뒤 그 팀이 경기를 치렀으면 에피소드가 끝난 것으로 보고 기록을 지운다.
// 나중에 다시 명단에 오르면 새 부상으로 처음부터 센다 (회복 후 정상 출전한 경기를 결장으로 세지 않도록).
// 빠진 사이 팀 경기가 없었다면 명단에서 잠깐 누락된 것일 수 있으므로 기록을 남겨 두고, 다시 오르면 이어서 센다.
// 명단 수집에 실패한 경우에는 이 함수가 호출되지 않으므로(injuries = null) 기록은 그대로 남는다.
import { readJson, withFileLock, writeJsonSync } from './store.js';

const keyOf = (i) => `${i.teamId}|${String(i.player || '').toLowerCase()}`;
const teamOfKey = (key) => key.slice(0, key.indexOf('|'));
// 경기가 없는 기간(비시즌 등)에 빠진 기록이 쌓이지 않도록 이 기간이 지나면 지운다
const STALE_MS = 30 * 86400e3;

/**
 * injuries: 이번에 "정상적으로 받은" 부상 명단 전체 (빈 배열 = 부상자 없음).
 */
export function annotateInjuries(leagueId, injuries, history, now = Date.now()) {
  if (!Array.isArray(injuries)) return injuries;

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
  const playedBetween = (teamId, from, to) => (gamesByTeam.get(teamId) || []).some((t) => t > from && t <= to);

  const file = `injuries-${leagueId}.json`;
  let seen = {};
  try {
    seen = withFileLock(`injuries-${leagueId}`, () => {
      const prev = readJson(file, {});
      const next = {};
      for (const i of injuries) {
        const key = keyOf(i);
        const updated = Date.parse(i.date);
        // 빠졌던 사이 팀 경기가 있었으면 회복 후 재부상이므로 예전 기록은 쓰지 않는다
        const old = prev[key]?.goneAt != null && playedBetween(i.teamId, prev[key].goneAt, now) ? undefined : prev[key];
        const first = Math.min(old?.firstSeen ?? now, Number.isFinite(updated) ? updated : now, now);
        next[key] = { firstSeen: first, lastSeen: now };
      }
      // 이번 명단에 없는 선수: 빠진 것을 처음 본 뒤(goneAt) 팀 경기가 있었으면 에피소드 종료(삭제), 없었으면 일시 누락으로 보고 유지
      for (const [key, rec] of Object.entries(prev)) {
        if (next[key]) continue;
        const goneAt = rec.goneAt ?? now;
        if (now - goneAt > STALE_MS) continue;
        if (playedBetween(teamOfKey(key), goneAt, now)) continue;
        next[key] = { ...rec, goneAt };
      }
      writeJsonSync(file, next);
      return next;
    });
  } catch (e) {
    console.warn(`[injury] 기록 실패: ${e.message}`);
  }

  return injuries.map((i) => {
    const rec = seen[keyOf(i)];
    const since = rec?.firstSeen ?? now;
    const gamesMissed = (gamesByTeam.get(i.teamId) || []).filter((t) => t > since && t <= now).length;
    return { ...i, outSince: new Date(since).toISOString(), gamesMissed };
  });
}
