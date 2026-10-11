import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { PORT, HOST, ACCESS_TOKEN_ENV, AI_MODEL, AI_TAG_MODEL, PHONE_MODE } from './src/config.js';
import { catalog, leagueOverview, gameDetail } from './src/service.js';
import { analyzeGame, aiEnabled, aiUsage } from './src/ai.js';
import { taggerEnabled } from './src/ai-tagger.js';
import { usageSummary } from './src/usage.js';
import { clearMemo } from './src/http.js';
import { readJson, writeJsonSync } from './src/store.js';
import { startTunnel, tunnelHost, tunnelState, tunnelUrl, onTunnelUrl } from './src/tunnel.js';
import { hasPassword, setPassword, login, logout, validSession, parseCookies, SESSION_DAYS, MIN_PASSWORD } from './src/auth.js';

const PUBLIC = path.join(import.meta.dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
// 폰 모드에서는 Cloudflare 터널로 인터넷 주소도 연다 (--no-tunnel 이면 같은 와이파이만)
const TUNNEL = PHONE_MODE && !process.argv.includes('--no-tunnel') && process.env.SP_NO_TUNNEL !== '1';
const SESSION_COOKIE = 'sp_session';

/**
 * QR 코드용 접속 토큰. ACCESS_TOKEN 환경변수가 없으면 처음 한 번 만들어 data/state/access-token.json 에 저장
 * (서버를 다시 켜도 같은 토큰이라 폰에 저장한 주소가 계속 동작)
 */
function newAccessToken() {
  const token = crypto.randomBytes(18).toString('base64url');
  writeJsonSync('access-token.json', { token, createdAt: new Date().toISOString() });
  return token;
}
function loadAccessToken() {
  if (ACCESS_TOKEN_ENV) return ACCESS_TOKEN_ENV;
  if (LOOPBACK && !TUNNEL) return '';
  return readJson('access-token.json', null)?.token || newAccessToken();
}
let ACCESS_TOKEN = loadAccessToken();

/**
 * 모든 기기의 접속 권한 회수: 비밀번호를 바꿀 때 QR 토큰도 새로 만든다 (예전 QR·폰 북마크는 더 이상 안 열림).
 * ACCESS_TOKEN 환경변수로 고정한 경우는 바꿀 수 없으므로 false
 */
function rotateAccessToken() {
  if (ACCESS_TOKEN_ENV || !ACCESS_TOKEN) return false;
  ACCESS_TOKEN = newAccessToken();
  return true;
}

// Tailscale(개인 VPN) 주소는 100.64.0.0/10
const isTailscale = (name, address) => /tailscale/i.test(name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);

/** 이 PC의 공유기 내부 주소 (가상 네트워크 어댑터 제외). 네트워크 정보를 못 읽는 환경이면 빈 목록 */
function lanAddresses() {
  if (LOOPBACK) return [];
  let ifaces = {};
  try {
    ifaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (/vEthernet|WSL|VirtualBox|VMware|Hyper-V|Docker|Loopback/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        out.push({ name, address: a.address, kind: isTailscale(name, a.address) ? 'tailscale' : 'lan' });
      }
    }
  }
  return out.sort((a, b) => (a.kind === 'tailscale' ? -1 : 0) - (b.kind === 'tailscale' ? -1 : 0));
}

const LOCAL_NAMES = ['localhost', '127.0.0.1', '::1'];
const hostNameOf = (req) => String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

/**
 * "이 PC에서 직접 연 화면"인지. 터널로 들어온 요청도 소켓은 127.0.0.1 이므로
 * Cloudflare 가 붙이는 헤더나 터널 주소(Host)가 있으면 외부 요청으로 본다.
 */
function isThisPc(req) {
  const loopSocket = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const viaCloudflare = !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cdn-loop']);
  return loopSocket && !viaCloudflare && LOCAL_NAMES.includes(hostNameOf(req));
}
const viaTunnel = (req) => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']) || hostNameOf(req) === tunnelHost();
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** 로그인(세션 쿠키) 또는 QR 토큰이 있는지 */
function isAuthed(req) {
  if (isThisPc(req)) return true;
  if (ACCESS_TOKEN && safeEqual(req.headers['x-access-token'] || '', ACCESS_TOKEN)) return true;
  return validSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('요청이 너무 큽니다'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('잘못된 요청 형식'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const thisPcOnly = (req) => {
  if (!isThisPc(req)) throw Object.assign(new Error('집 PC에서만 할 수 있습니다'), { status: 403 });
};

function sessionCookie(req, value, maxAge) {
  // 터널(https)로 들어온 경우에만 Secure (같은 와이파이 http 주소에서는 Secure 쿠키가 저장되지 않음)
  const secure = viaTunnel(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

/* ---------- API ---------- */
// public: 로그인 없이 부를 수 있는 API
const routes = [
  { method: 'GET', re: /^\/api\/auth$/, public: true, fn: (_, req) => ({ thisPc: isThisPc(req), authed: isAuthed(req), hasPassword: hasPassword() }) },
  {
    method: 'POST',
    re: /^\/api\/login$/,
    public: true,
    fn: async (_, req, res) => {
      const body = await readBody(req);
      const id = login(body.password, clientIp(req));
      res.setHeader('Set-Cookie', sessionCookie(req, id, SESSION_DAYS * 86400));
      return { ok: true };
    },
  },
  {
    method: 'POST',
    re: /^\/api\/logout$/,
    public: true,
    fn: (_, req, res) => {
      logout(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return { ok: true };
    },
  },
  {
    method: 'POST',
    re: /^\/api\/password$/,
    fn: async (_, req) => {
      thisPcOnly(req); // 비밀번호는 집 PC에서만 정하거나 바꿀 수 있다
      const changing = hasPassword();
      setPassword((await readBody(req)).password); // 모든 로그인 세션 종료
      // 바꾸는 경우엔 QR 토큰도 새로 만들어 예전 QR·폰 북마크 접속까지 끊는다 (처음 정할 때는 폰 QR 유지)
      const tokenRotated = changing ? rotateAccessToken() : false;
      return { ok: true, tokenRotated, tokenFixedByEnv: changing && !!ACCESS_TOKEN_ENV };
    },
  },
  {
    method: 'GET',
    re: /^\/api\/catalog$/,
    fn: () => ({
      sports: catalog(),
      ai: { enabled: aiEnabled(), model: AI_MODEL, usage: aiUsage(), tagging: { enabled: taggerEnabled(), model: AI_TAG_MODEL } },
    }),
  },
  { method: 'GET', re: /^\/api\/usage$/, fn: () => usageSummary() },
  { method: 'GET', re: /^\/api\/league\/([\w-]+)$/, fn: ([id]) => leagueOverview(id) },
  { method: 'GET', re: /^\/api\/game\/([\w-]+)\/([\w-]+)$/, fn: ([l, g]) => gameDetail(l, g) },
  { method: 'POST', re: /^\/api\/ai\/([\w-]+)\/([\w-]+)$/, fn: ([l, g]) => analyzeGame(l, g) },
  { method: 'POST', re: /^\/api\/refresh\/([\w-]+)$/, fn: ([id]) => (clearMemo(`league:${id}`), leagueOverview(id)) },
  // 폰·다른 PC 접속 안내 (QR에 토큰이 들어 있으므로 집 PC에서 연 화면에만 준다)
  { method: 'GET', re: /^\/api\/phone$/, fn: (_, req) => (thisPcOnly(req), phoneInfo()) },
];

const qr = (url) => QRCode.toString(url, { type: 'svg', margin: 1, width: 220 });
const withToken = (base) => `${base}/?token=${encodeURIComponent(ACCESS_TOKEN)}`;

async function phoneInfo() {
  const t = tunnelState();
  const tunnel = TUNNEL
    ? { ...t, qrUrl: t.url ? withToken(t.url) : null, svg: t.url ? await qr(withToken(t.url)) : null }
    : { status: 'off' };
  return {
    enabled: !LOOPBACK || TUNNEL,
    hasPassword: hasPassword(),
    minPassword: MIN_PASSWORD,
    tunnel,
    addresses: await Promise.all(
      lanAddresses().map(async (a) => {
        const url = withToken(`http://${a.address}:${PORT}`);
        return { ...a, url, svg: await qr(url) };
      }),
    ),
  };
}

/** 요청 출처 검사. 실패하면 [상태코드, 메시지, 코드] */
function checkAccess(req, route) {
  // Host 헤더는 localhost, 이 PC의 공유기 내부 주소, 현재 터널 주소만 허용 (DNS 리바인딩 차단)
  const allowed = [...LOCAL_NAMES, ...lanAddresses().map((a) => a.address), ...(tunnelHost() ? [tunnelHost()] : [])];
  if (!allowed.includes(hostNameOf(req))) return [403, '허용되지 않은 호스트'];
  // 다른 웹사이트가 브라우저를 통해 이 서버로 POST(유료 AI 실행·로그인 등)를 보내지 못하게 한다
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {}
    if (originHost !== String(req.headers.host || '').toLowerCase()) return [403, '다른 사이트에서 온 요청은 허용하지 않습니다'];
  }
  if (!route?.public && !isAuthed(req)) return [401, '로그인이 필요합니다', 'login_required'];
  return null;
}

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return json(res, 400, { error: 'bad path' });
  }
  const file = path.resolve(PUBLIC, `.${path.posix.normalize(rel)}`);
  const inside = path.relative(PUBLIC, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return json(res, 400, { error: '잘못된 요청 주소' });
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

  const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  const denied = checkAccess(req, route);
  if (denied) return json(res, denied[0], { error: denied[1], code: denied[2] });
  if (!route) return json(res, 404, { error: 'not found' });
  try {
    return json(res, 200, await route.fn(url.pathname.match(route.re).slice(1), req, res));
  } catch (e) {
    if ((e.status || 500) >= 500) console.error(`[api] ${url.pathname}:`, e.message);
    return json(res, e.status || 500, { error: e.message });
  }
}

const onRequest = (req, res) => {
  // 다른 기기·터널 접속은 기록 (안 열릴 때 요청이 PC까지 오는지 확인용, 토큰은 가림)
  if (!isThisPc(req)) {
    res.on('finish', () => {
      const via = viaTunnel(req) ? '인터넷' : '와이파이';
      console.log(`[${via} 접속] ${clientIp(req)} ${req.method} ${String(req.url).replace(/token=[^&]+/, 'token=***')} → ${res.statusCode}`);
    });
  }
  handle(req, res).catch((e) => {
    console.error('[server] 요청 처리 오류:', e);
    if (!res.headersSent) json(res, 500, { error: '서버 오류' });
    else res.destroy();
  });
};

// 브라우저가 localhost 를 IPv4(127.0.0.1) 또는 IPv6(::1) 중 어느 쪽으로 찾아도 열리도록 둘 다 연다
// (폰 모드는 0.0.0.0 = 모든 IPv4 + ::1)
const hosts = LOOPBACK ? ['127.0.0.1', '::1'] : HOST === '0.0.0.0' ? ['0.0.0.0', '::1'] : [HOST];
let opened = 0;
for (const [i, host] of hosts.entries()) {
  const server = http.createServer(onRequest);
  server.on('error', (e) => {
    if (i === 0) {
      console.error(`서버를 열 수 없습니다 (${host}:${PORT}): ${e.message}`);
      process.exit(1);
    }
  });
  server.listen(PORT, host, () => {
    if (opened++) return;
    console.log(`승부예측 대시보드: http://localhost:${PORT}`);
    console.log(`  (열리지 않으면 http://127.0.0.1:${PORT})`);
    if (PHONE_MODE) {
      const lan = lanAddresses().map((a) => `http://${a.address}:${PORT}`).join(', ');
      if (lan) console.log(`같은 와이파이: ${lan}`);
      if (!hasPassword()) console.log('※ 비밀번호가 아직 없습니다. 집 PC 화면 오른쪽 위 "폰·다른 PC로 보기"에서 정하세요 (다른 PC 로그인용).');
      if (TUNNEL && !startTunnel(PORT)) console.log(`인터넷 주소를 열지 못했습니다: ${tunnelState().error}`);
      else if (TUNNEL) console.log('인터넷 주소 여는 중… (몇 초 걸립니다)');
    } else {
      console.log('  폰·다른 PC에서도 보려면: npm run phone');
    }
    console.log(aiEnabled() ? `AI 분석 사용 가능 (${AI_MODEL})` : 'AI 분석 꺼짐 (ANTHROPIC_API_KEY 미설정) — 통계모델만 사용');
  });
}

// 인터넷 주소가 생기거나 바뀌면 크게 알린다 (크롬 원격 데스크톱으로 이 화면만 보면 새 주소를 알 수 있게)
onTunnelUrl(async (url) => {
  const line = '='.repeat(64);
  console.log(`\n${line}\n  인터넷 주소 (데이터·다른 PC): ${url}\n  ${new Date().toLocaleString('ko-KR')} 기준 — PC를 다시 켜면 바뀝니다\n${line}`);
  try {
    console.log(await QRCode.toString(withToken(url), { type: 'terminal', small: true }));
    console.log('  ↑ 폰 카메라로 찍으면 비밀번호 없이 바로 열립니다. 다른 PC는 위 주소를 열고 비밀번호로 로그인.\n');
  } catch {}
});
