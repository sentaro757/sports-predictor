// Cloudflare 임시 터널: cloudflared 를 실행해 https://○○○.trycloudflare.com 주소로 이 서버를 인터넷에 연결한다.
// 가입이 필요 없는 대신 cloudflared 를 다시 켤 때마다 주소가 바뀐다. 끊기면 자동으로 다시 연결한다(이때도 주소가 바뀜).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const state = { status: 'off', url: null, since: null, error: null, restarts: 0 };
const listeners = new Set();
let child = null;
let stopping = false;

export const tunnelState = () => ({ ...state });
export const tunnelUrl = () => state.url;
export const tunnelHost = () => (state.url ? new URL(state.url).host : null);
export const onTunnelUrl = (fn) => listeners.add(fn);

/** cloudflared 실행 파일 찾기: CLOUDFLARED 환경변수 → PATH → 기본 설치 위치 */
export function findCloudflared() {
  if (process.env.CLOUDFLARED && fs.existsSync(process.env.CLOUDFLARED)) return process.env.CLOUDFLARED;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  const found = which.status === 0 ? which.stdout.split(/\r?\n/).find(Boolean) : null;
  if (found) return found.trim();
  const candidates = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function setUrl(url) {
  if (state.url === url) return;
  Object.assign(state, { status: 'on', url, since: new Date().toISOString(), error: null });
  for (const fn of listeners) fn(url);
}

/**
 * 터널 시작. 테스트용으로 SP_FAKE_TUNNEL 에 주소를 넣으면 cloudflared 없이 그 주소를 쓴다.
 */
export function startTunnel(port) {
  if (process.env.SP_FAKE_TUNNEL) {
    setUrl(process.env.SP_FAKE_TUNNEL);
    return true;
  }
  const bin = findCloudflared();
  if (!bin) {
    Object.assign(state, { status: 'missing', error: 'cloudflared 가 설치돼 있지 않습니다 (winget install Cloudflare.cloudflared)' });
    return false;
  }
  const run = () => {
    Object.assign(state, { status: 'starting', url: null, error: null });
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true });
    const onData = (buf) => {
      const m = String(buf).match(URL_RE);
      if (m) setUrl(m[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => Object.assign(state, { status: 'error', error: e.message }));
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      // 끊기면 다시 연결 (점점 길게 기다림, 최대 1분)
      state.restarts++;
      Object.assign(state, { status: 'reconnecting', url: null, error: `cloudflared 종료 (코드 ${code}) — 다시 연결 중` });
      setTimeout(run, Math.min(60000, 2000 * state.restarts));
    });
  };
  run();
  const stop = () => {
    stopping = true;
    child?.kill();
  };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stop(), process.exit(0)));
  return true;
}
