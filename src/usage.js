// AI 사용량·비용 기록. API 응답의 usage(실제 토큰 수)로 계산해 data/cache/ai-usage.json 에 날짜별로 저장한다.
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.AI_USAGE_FILE || path.join(import.meta.dirname, '..', 'data', 'cache', 'ai-usage.json');
const KEEP_DAYS = 120;
export const USD_KRW = Number(process.env.USD_KRW || 1400); // 원화 환산용 환율 (대략값)

// 100만 토큰당 달러 (Anthropic API 정가). cacheRead/cacheWrite 가 없으면 입력 단가의 0.1배 / 1.25배로 계산
const PRICES = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longAbove: 100_000 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
];

const priceOf = (model) => PRICES.find(([id]) => model === id || String(model).startsWith(`${id}-`))?.[1] || null;

/** usage 하나의 비용(달러). 가격표에 없는 모델이면 null */
export function costOf(model, usage) {
  const p = priceOf(model);
  if (!p || !usage) return null;
  const input = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const long = p.longAbove && input + cacheRead + cacheWrite > p.longAbove;
  const inRate = long ? p.longInput : p.input;
  const outRate = long ? p.longOutput : p.output;
  return (
    (input * inRate + cacheRead * (p.cacheRead ?? inRate * 0.1) + cacheWrite * (p.cacheWrite ?? inRate * 1.25) + output * outRate) / 1e6
  );
}

const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

let data = null;
function load() {
  if (!data) {
    try {
      data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      data = { days: {} };
    }
  }
  return data;
}

let saving = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(data);
  saving = saving.then(async () => {
    const tmp = `${FILE}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
      await fs.promises.writeFile(tmp, snapshot);
      await fs.promises.rename(tmp, FILE);
    } catch (e) {
      console.warn(`[usage] 저장 실패: ${e.message}`);
    }
  });
  return saving;
}

/**
 * API 응답 한 건을 기록하고 그 호출의 비용 정보를 돌려준다.
 * feature: 'analysis' (AI 분석 버튼) | 'tagging' (기사 분류)
 */
export function recordUsage(feature, response) {
  const d = load();
  const day = kstDay();
  const model = response?.model || 'unknown';
  const u = response?.usage || {};
  const cost = costOf(model, u);
  const bucket = (((d.days[day] ||= {})[feature] ||= {}))[model] ||= { calls: 0, input: 0, output: 0, cost: 0, unpriced: 0 };
  bucket.calls++;
  bucket.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  bucket.output += u.output_tokens || 0;
  if (cost == null) bucket.unpriced++;
  else bucket.cost += cost;
  // 오래된 날짜 정리
  const cutoff = new Date(Date.now() + 9 * 3600e3 - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
  for (const k of Object.keys(d.days)) if (k < cutoff) delete d.days[k];
  save();
  return { model, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, costUsd: cost, costKrw: cost == null ? null : Math.round(cost * USD_KRW) };
}

/** 오늘 / 이번 달 / 기능별·모델별 합계 */
export function usageSummary() {
  const d = load();
  const today = kstDay();
  const month = today.slice(0, 7);
  const empty = () => ({ calls: 0, input: 0, output: 0, cost: 0, unpriced: 0 });
  const add = (a, b) => {
    for (const k of Object.keys(a)) a[k] += b[k] || 0;
    return a;
  };
  const sum = (filter) => {
    const total = empty();
    const byFeature = {};
    for (const [day, features] of Object.entries(d.days)) {
      if (!filter(day)) continue;
      for (const [feature, models] of Object.entries(features)) {
        for (const [model, b] of Object.entries(models)) {
          add(total, b);
          add(((byFeature[feature] ||= {})[model] ||= empty()), b);
        }
      }
    }
    return { ...total, krw: Math.round(total.cost * USD_KRW), byFeature };
  };
  return { usdKrw: USD_KRW, today: sum((day) => day === today), month: sum((day) => day.startsWith(month)) };
}
