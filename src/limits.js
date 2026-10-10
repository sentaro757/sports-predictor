// AI 하루 호출 한도. data/state/ai-limits.json 에 날짜별로 저장해서 서버를 껐다 켜도, 두 개를 띄워도 유지된다.
// 정책: API 요청을 보내기 "전에" 한 칸을 예약하고, 결과(성공·실패·형식 오류 재시도)와 상관없이 그대로 센다.
//       (실패해도 요금이 나갔을 수 있으므로 보수적으로 계산)
import { readJson, withFileLock, writeJsonSync } from './store.js';

const FILE = 'ai-limits.json';
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function today(data) {
  const day = kstDay();
  if (data.day !== day) return { day, counts: {} };
  return { day, counts: data.counts || {} };
}

const limitError = (feature, limit) =>
  Object.assign(
    new Error(
      feature === 'analysis'
        ? `오늘 AI 분석 한도(${limit}회)를 다 썼습니다. AI_DAILY_LIMIT 으로 조정할 수 있습니다`
        : `오늘 AI 기사 분류 한도(${limit}회)를 다 썼습니다. AI_TAG_DAILY_LIMIT 으로 조정할 수 있습니다`,
    ),
    { status: 429 },
  );

/** 한도 확인만 (예약하지 않음) */
export function checkLimit(feature, limit) {
  const t = today(readJson(FILE, {}));
  if ((t.counts[feature] || 0) >= limit) throw limitError(feature, limit);
}

/** 한 칸 예약. 한도를 넘으면 429 오류 */
export function reserveCall(feature, limit) {
  return withFileLock('ai-limits', () => {
    const t = today(readJson(FILE, {}));
    const used = t.counts[feature] || 0;
    if (used >= limit) throw limitError(feature, limit);
    t.counts[feature] = used + 1;
    writeJsonSync(FILE, t);
    return t.counts[feature];
  });
}

export function callsToday(feature) {
  return today(readJson(FILE, {})).counts[feature] || 0;
}
