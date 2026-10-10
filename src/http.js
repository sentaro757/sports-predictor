import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CACHE_DIR = path.join(import.meta.dirname, '..', 'data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const memory = new Map(); // key -> { at, data }
const inflight = new Map(); // key -> Promise

// 동시 요청 수 제한 (소스 사이트에 부담을 주지 않기 위해)
const MAX_CONCURRENT = 6;
let active = 0;
const queue = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) sports-predictor/0.1',
  Referer: 'https://m.sports.naver.com/',
  Accept: 'application/json, text/xml, */*',
};

function cacheFile(key) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}

function readDisk(key) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * URL을 가져와 캐시한다. ttl(초) 안에는 캐시를 그대로 쓰고,
 * 요청이 실패하면 오래된 캐시라도 돌려준다.
 */
export async function fetchCached(url, { ttl = 600, type = 'json' } = {}) {
  const key = `${type}:${url}`;
  const now = Date.now();
  let hit = memory.get(key) || readDisk(key);
  if (hit) memory.set(key, hit);
  if (hit && now - hit.at < ttl * 1000) return hit.data;
  if (inflight.has(key)) return inflight.get(key);

  const p = withSlot(async () => {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const data = type === 'json' ? await res.json() : await res.text();
    const entry = { at: Date.now(), data };
    memory.set(key, entry);
    fs.writeFile(cacheFile(key), JSON.stringify(entry), () => {});
    return data;
  })
    .catch((err) => {
      if (hit) {
        console.warn(`[fetch] 실패, 이전 캐시 사용: ${err.message}`);
        return hit.data;
      }
      throw err;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

// 계산 결과(Elo 등)를 위한 간단한 메모리 캐시
const computed = new Map();
export async function memo(key, ttl, fn) {
  const hit = computed.get(key);
  if (hit && Date.now() - hit.at < ttl * 1000) return hit.value;
  if (hit?.pending) return hit.pending;
  const pending = fn().then(
    (value) => {
      computed.set(key, { at: Date.now(), value });
      return value;
    },
    (err) => {
      computed.delete(key);
      throw err;
    },
  );
  computed.set(key, { ...hit, pending });
  return pending;
}

export function clearMemo(prefix = '') {
  for (const k of computed.keys()) if (k.startsWith(prefix)) computed.delete(k);
}
