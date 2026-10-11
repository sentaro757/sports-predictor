// 화면에 낸 예측을 경기 시작 전에 저장해 둔다 (data/state/predictions-<리그>.json).
// 나중에 실제 결과와 비교해 부상·뉴스 보정까지 포함한 "실제 예측"이 맞았는지 검증하기 위해 (scripts/review-recent.js).
// 경기마다 처음 예측(first)과 시작 직전 마지막 예측(last)만 남긴다. 시작한 경기는 더 이상 바꾸지 않는다.
import { readJson, withFileLock, writeJsonSync } from './store.js';

const KEEP_MS = 120 * 86400e3; // 4개월 지난 경기 기록은 지운다
const round = (x) => Math.round(x * 1000) / 1000;

function snapshot(p, now) {
  const adj = (s) => Object.fromEntries(Object.entries(p[s].adj).map(([k, v]) => [k, round(v)]));
  return {
    at: new Date(now).toISOString(),
    probs: { home: round(p.probs.home), draw: round(p.probs.draw), away: round(p.probs.away) },
    pick: p.pick,
    elo: { home: Math.round(p.home.elo), away: Math.round(p.away.elo) },
    adj: { home: adj('home'), away: adj('away') },
  };
}

const sameProbs = (a, b) => a && b && ['home', 'draw', 'away'].every((k) => a.probs[k] === b.probs[k]);

/** items: [{ game, prediction }] (prediction = model.predictGame 결과) */
export function logPredictions(leagueId, items, now = Date.now()) {
  const pending = items.filter(({ game }) => Date.parse(game.date) > now);
  return withFileLock(`predictions-${leagueId}`, () => {
    const file = `predictions-${leagueId}.json`;
    const log = readJson(file, {});
    let changed = false;
    for (const id of Object.keys(log)) {
      if (now - Date.parse(log[id].date) > KEEP_MS) {
        delete log[id];
        changed = true;
      }
    }
    for (const { game, prediction } of pending) {
      const snap = snapshot(prediction, now);
      const rec = log[game.id];
      if (!rec) {
        log[game.id] = { date: game.date, home: game.home.id, away: game.away.id, preseason: !!game.preseason, first: snap, last: snap };
        changed = true;
      } else if (!sameProbs(rec.last, snap)) {
        rec.date = game.date; // 일정 변경 반영
        rec.last = snap;
        changed = true;
      }
    }
    if (changed) writeJsonSync(file, log);
    return log;
  });
}

export const readPredictionLog = (leagueId) => readJson(`predictions-${leagueId}.json`, {});
