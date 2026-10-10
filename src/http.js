import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CACHE_DIR = path.join(import.meta.dirname, '..', 'data', 'cache');
const DISK_MAX_AGE = 14 * 86400e3; // 이보다 오래된 디스크 캐시는 시작할 때 정리
const MEMORY_MAX_AGE = 2 * 86400e3;
fs.mkdirSync(CACHE_DIR, { recursive: true });

const memory = new Map(); // key -> { at, data }
const inflight = new Map(); // key -> Promise<{ data, stale }>

// 동시 요청 수 제한 (소스 사이트에 부담을 주지 않기 위해).
// 작업이 끝나면 대기자에게 슬롯을 직접 넘겨서, 그 사이에 새 요청이 끼어들어 한도를 넘지 않게 한다.
const MAX_CONCURRENT = 6;
let active = 0;
const queue = [];
async function withSlot(fn) {
  if (active < MAX_CONCURRENT) active++;
  else await new Promise((resolve) => queue.push(resolve)); // 깨어날 때 슬롯을 넘겨받음 (active 그대로)
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
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
    return null; // 없거나 깨진 파일
  }
}

// 임시 파일에 쓴 뒤 rename 해서, 다른 프로세스가 반쯤 쓰인 파일을 읽지 않게 한다
async function writeDisk(key, entry) {
  const file = cacheFile(key);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(entry));
    await fs.promises.rename(tmp, file);
  } catch (err) {
    console.warn(`[cache] 저장 실패 ${path.basename(file)}: ${err.message}`);
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// 네트워크 응답 캐시 파일(sha1 해시 이름)만 정리한다. 다른 이름의 파일은 절대 지우지 않는다
// (비용 기록·AI 분류 같은 보관용 상태는 data/state/ 에 있고, 각자 보존 기간으로 정리된다)
const CACHE_FILE = /^[0-9a-f]{40}\.json$/;
const CACHE_TMP = /^[0-9a-f]{40}\.json\.\d+\.[0-9a-f]+\.tmp$/;

export function sweepDisk(dir = CACHE_DIR, now = Date.now()) {
  for (const name of fs.readdirSync(dir)) {
    const isCache = CACHE_FILE.test(name);
    const isTmp = CACHE_TMP.test(name);
    if (!isCache && !isTmp) continue;
    const file = path.join(dir, name);
    try {
      const age = now - fs.statSync(file).mtimeMs;
      if (isTmp ? age > 3600e3 : age > DISK_MAX_AGE) fs.unlinkSync(file);
    } catch {}
  }
}
sweepDisk();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (now - v.at > MEMORY_MAX_AGE) memory.delete(k);
}, 3600e3).unref();

/**
 * URL을 가져와 캐시한다. ttl(초) 안에는 캐시를 그대로 쓰고,
 * 요청이 실패하면 오래된 캐시라도 돌려주며 warn 콜백으로 알린다.
 */
export async function fetchCached(url, { ttl = 600, type = 'json', warn } = {}) {
  const key = `${type}:${url}`;
  const hit = memory.get(key) || readDisk(key);
  if (hit) memory.set(key, hit);
  if (hit && Date.now() - hit.at < ttl * 1000) return hit.data;

  let p = inflight.get(key);
  if (!p) {
    p = withSlot(async () => {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const data = type === 'json' ? await res.json() : await res.text();
      const entry = { at: Date.now(), data };
      memory.set(key, entry);
      writeDisk(key, entry);
      return { data, stale: false };
    })
      .catch((err) => {
        if (!hit) throw err;
        console.warn(`[fetch] 실패, 이전 캐시 사용: ${err.message}`);
        return { data: hit.data, stale: true, error: err.message };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const r = await p;
  if (r.stale) warn?.(`오래된 캐시 사용 (${new Date(hit.at).toLocaleString('ko-KR')}): ${r.error}`);
  return r.data;
}

// 계산 결과(Elo 등)를 위한 메모리 캐시.
// 항목마다 세대 번호를 두고, clearMemo 이후에 끝난 이전 계산은 결과를 저장하지 않는다.
const computed = new Map(); // key -> { at, value, pending, gen }
let generation = 0;

export async function memo(key, ttl, fn) {
  const hit = computed.get(key);
  if (hit && 'value' in hit && Date.now() - hit.at < ttl * 1000) return hit.value;
  if (hit?.pending) return hit.pending;
  const gen = ++generation;
  const pending = fn().then(
    (value) => {
      if (computed.get(key)?.gen === gen) computed.set(key, { at: Date.now(), value, gen });
      return value;
    },
    (err) => {
      const cur = computed.get(key);
      if (cur?.gen === gen) {
        // 실패하면 이전 값이 있으면 유지하고, 없으면 지운다
        if ('value' in cur) computed.set(key, { at: cur.at, value: cur.value, gen });
        else computed.delete(key);
      }
      throw err;
    },
  );
  computed.set(key, { ...(hit && 'value' in hit ? { at: hit.at, value: hit.value } : {}), pending, gen });
  return pending;
}

export function clearMemo(prefix = '') {
  for (const k of computed.keys()) if (k.startsWith(prefix)) computed.delete(k);
}
