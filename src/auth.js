// 비밀번호 로그인 (아이디 없이 비밀번호 하나). 터널·다른 기기에서 접속할 때 사용한다. 이 PC 자신은 로그인 없이 열린다.
//  - 비밀번호는 scrypt 해시로만 저장 (data/state/auth.json)
//  - 로그인하면 30일짜리 세션 쿠키. 세션 ID 자체는 저장하지 않고 sha256 해시만 저장 (data/state/sessions.json)
//  - 비밀번호를 바꾸면 모든 세션이 끊긴다
//  - 틀린 비밀번호: 같은 IP에서 15분에 5번, 전체 1시간에 30번 넘으면 잠시 막는다
import crypto from 'node:crypto';
import { readJson, withFileLock, writeJsonSync } from './store.js';

const AUTH_FILE = 'auth.json';
const SESSION_FILE = 'sessions.json';
export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 6;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');

export const hasPassword = () => !!readJson(AUTH_FILE, null)?.hash;

export function setPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
    throw Object.assign(new Error(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`), { status: 400 });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  writeJsonSync(AUTH_FILE, { salt, hash: scrypt(pw, salt), updatedAt: new Date().toISOString() });
  writeJsonSync(SESSION_FILE, {}); // 기존 로그인 모두 끊기
}

function verifyPassword(pw) {
  const a = readJson(AUTH_FILE, null);
  if (!a?.hash || typeof pw !== 'string') return false;
  const x = Buffer.from(scrypt(pw, a.salt), 'hex');
  const y = Buffer.from(a.hash, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- 틀린 비밀번호 제한 ---------- */
const failures = new Map(); // ip -> [시각...]
let globalFailures = [];
const recent = (list, ms) => list.filter((t) => Date.now() - t < ms);

function checkRate(ip) {
  const mine = recent(failures.get(ip) || [], 15 * 60e3);
  globalFailures = recent(globalFailures, 3600e3);
  if (mine.length >= 5) throw Object.assign(new Error('비밀번호를 여러 번 틀렸습니다. 15분 뒤에 다시 시도하세요'), { status: 429 });
  if (globalFailures.length >= 30) throw Object.assign(new Error('로그인 시도가 너무 많습니다. 잠시 뒤에 다시 시도하세요'), { status: 429 });
}

function recordFailure(ip) {
  failures.set(ip, [...recent(failures.get(ip) || [], 15 * 60e3), Date.now()]);
  globalFailures.push(Date.now());
}

/** 로그인 → 새 세션 ID (쿠키에 넣을 값) */
export function login(pw, ip) {
  if (!hasPassword()) throw Object.assign(new Error('아직 비밀번호가 정해지지 않았습니다. 집 PC의 "폰·다른 PC로 보기" 창에서 정하세요'), { status: 403 });
  checkRate(ip);
  if (!verifyPassword(pw)) {
    recordFailure(ip);
    throw Object.assign(new Error('비밀번호가 맞지 않습니다'), { status: 401 });
  }
  failures.delete(ip);
  const id = crypto.randomBytes(32).toString('base64url');
  withFileLock('sessions', () => {
    const s = readJson(SESSION_FILE, {});
    const now = Date.now();
    for (const [k, v] of Object.entries(s)) if (now - v.created > SESSION_DAYS * 86400e3) delete s[k];
    s[sha256(id)] = { created: now };
    writeJsonSync(SESSION_FILE, s);
  });
  return id;
}

export function validSession(id) {
  if (!id) return false;
  const v = readJson(SESSION_FILE, {})[sha256(id)];
  return !!v && Date.now() - v.created < SESSION_DAYS * 86400e3;
}

export function logout(id) {
  if (!id) return;
  withFileLock('sessions', () => {
    const s = readJson(SESSION_FILE, {});
    delete s[sha256(id)];
    writeJsonSync(SESSION_FILE, s);
  });
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
