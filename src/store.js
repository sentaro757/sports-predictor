// 오래 보관해야 하는 상태(AI 비용 기록, AI 기사 분류, 부상 추적, AI 호출 한도)를 data/state/ 에 JSON 으로 저장한다.
// data/cache/ 는 네트워크 응답 캐시라 주기적으로 지워지므로 여기와 섞지 않는다.
import fs from 'node:fs';
import path from 'node:path';

export const STATE_DIR = process.env.SP_STATE_DIR || path.join(import.meta.dirname, '..', 'data', 'state');
const OLD_CACHE_DIR = path.join(import.meta.dirname, '..', 'data', 'cache');
fs.mkdirSync(STATE_DIR, { recursive: true });

export const statePath = (name) => path.join(STATE_DIR, name);

/** 예전 버전이 data/cache/ 에 두던 파일을 data/state/ 로 옮긴다 */
function migrate(name) {
  const now = statePath(name);
  const old = path.join(OLD_CACHE_DIR, name);
  if (!process.env.SP_STATE_DIR && !fs.existsSync(now) && fs.existsSync(old)) {
    try {
      fs.renameSync(old, now);
    } catch {}
  }
}

export function readJson(name, fallback) {
  migrate(name);
  try {
    return JSON.parse(fs.readFileSync(statePath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

/** 임시 파일에 쓴 뒤 rename (다른 프로세스가 반쯤 쓰인 파일을 읽지 않게) */
export function writeJsonSync(name, data) {
  const file = statePath(name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 프로세스 간 잠금 아래에서 fn 을 실행한다 (서버를 두 개 띄워도 한도 계산이 겹치지 않게).
 * 잠금 파일이 10초 넘게 남아 있으면 비정상 종료로 보고 지운다.
 */
export function withFileLock(name, fn) {
  const lock = statePath(`${name}.lock`);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock);
      } catch {}
      if (Date.now() > deadline) throw new Error('상태 파일 잠금을 얻지 못했습니다');
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {}
  }
}
