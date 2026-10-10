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

const PUBLIC = path.join(import.meta.dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);

/**
 * 외부(폰) 접속용 토큰. ACCESS_TOKEN 환경변수가 없으면 처음 한 번 만들어 data/state/access-token.json 에 저장
 * (서버를 다시 켜도 같은 토큰이라 폰에 저장한 주소가 계속 동작)
 */
function loadAccessToken() {
  if (ACCESS_TOKEN_ENV) return ACCESS_TOKEN_ENV;
  if (LOOPBACK) return '';
  const saved = readJson('access-token.json', null);
  if (saved?.token) return saved.token;
  const token = crypto.randomBytes(18).toString('base64url');
  writeJsonSync('access-token.json', { token, createdAt: new Date().toISOString() });
  return token;
}
const ACCESS_TOKEN = loadAccessToken();

/** 이 PC의 공유기 내부 주소 (가상 네트워크 어댑터 제외) */
// Tailscale(개인 VPN) 주소는 100.64.0.0/10 — 폰이 모바일 데이터여도 접속 가능
const isTailscale = (name, address) => /tailscale/i.test(name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|VirtualBox|VMware|Hyper-V|Docker|Loopback/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        out.push({ name, address: a.address, kind: isTailscale(name, a.address) ? 'tailscale' : 'lan' });
      }
    }
  }
  // Tailscale 주소를 먼저 (와이파이·데이터 어디서나 되므로)
  return out.sort((a, b) => (a.kind === 'tailscale' ? -1 : 0) - (b.kind === 'tailscale' ? -1 : 0));
}

const isLocalClient = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const routes = [
  [
    'GET',
    /^\/api\/catalog$/,
    () => ({
      sports: catalog(),
      ai: { enabled: aiEnabled(), model: AI_MODEL, usage: aiUsage(), tagging: { enabled: taggerEnabled(), model: AI_TAG_MODEL } },
    }),
  ],
  ['GET', /^\/api\/usage$/, () => usageSummary()],
  ['GET', /^\/api\/league\/([\w-]+)$/, ([id]) => leagueOverview(id)],
  ['GET', /^\/api\/game\/([\w-]+)\/([\w-]+)$/, ([l, g]) => gameDetail(l, g)],
  ['POST', /^\/api\/ai\/([\w-]+)\/([\w-]+)$/, ([l, g]) => analyzeGame(l, g)],
  ['POST', /^\/api\/refresh\/([\w-]+)$/, ([id]) => (clearMemo(`league:${id}`), leagueOverview(id))],
  // 폰 접속용 QR (토큰이 들어 있으므로 이 PC에서 연 화면에만 준다)
  ['GET', /^\/api\/phone$/, (_, req) => phoneInfo(req)],
];

async function phoneInfo(req) {
  if (!isLocalClient(req)) throw Object.assign(new Error('이 PC에서만 볼 수 있습니다'), { status: 403 });
  if (LOOPBACK) return { enabled: false };
  const addrs = lanAddresses();
  return {
    enabled: true,
    addresses: await Promise.all(
      addrs.map(async ({ name, address, kind }) => {
        const url = `http://${address}:${PORT}/?token=${encodeURIComponent(ACCESS_TOKEN)}`;
        return { name, address, kind, url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, width: 220 }) };
      }),
    ),
  };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** 요청 출처 검사. 실패하면 [상태코드, 메시지] */
function checkAccess(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const hostName = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  // Host 헤더는 localhost 또는 이 PC의 공유기 내부 주소여야 한다 (DNS 리바인딩 차단)
  const allowedHosts = ['localhost', '127.0.0.1', '::1', ...(LOOPBACK ? [] : lanAddresses().map((a) => a.address))];
  if (!allowedHosts.includes(hostName)) return [403, '허용되지 않은 호스트'];
  // 다른 웹사이트가 브라우저를 통해 이 서버로 POST(유료 AI 실행 등)를 보내지 못하게 한다
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {}
    if (originHost !== host) return [403, '다른 사이트에서 온 요청은 허용하지 않습니다'];
  }
  // 이 PC 자신은 토큰 없이, 다른 기기(폰)는 토큰이 있어야 한다
  if (ACCESS_TOKEN && !isLocalClient(req) && !safeEqual(req.headers['x-access-token'] || '', ACCESS_TOKEN)) {
    return [401, '접속 토큰이 필요합니다. PC 화면의 "폰으로 보기" QR 코드로 접속하세요'];
  }
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

  const denied = checkAccess(req);
  if (denied) return json(res, denied[0], { error: denied[1] });
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (m && req.method === method) {
      try {
        return json(res, 200, await handler(m.slice(1), req));
      } catch (e) {
        console.error(`[api] ${url.pathname}:`, e.message);
        return json(res, e.status || 500, { error: e.message });
      }
    }
  }
  return json(res, 404, { error: 'not found' });
}

const onRequest = (req, res) => {
  // 폰 등 다른 기기의 접속은 기록해서, 폰에서 안 열릴 때 요청이 PC까지 오는지 확인할 수 있게 한다
  if (!LOOPBACK && !isLocalClient(req)) {
    res.on('finish', () => {
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      console.log(`[다른 기기] ${ip} ${req.method} ${String(req.url).replace(/token=[^&]+/, 'token=***')} → ${res.statusCode}`);
    });
  }
  handle(req, res).catch((e) => {
    console.error('[server] 요청 처리 오류:', e);
    if (!res.headersSent) json(res, 500, { error: '서버 오류' });
    else res.destroy();
  });
};

if (!LOOPBACK && !ACCESS_TOKEN) {
  console.error(`HOST=${HOST} 로 외부 접속을 열려면 접속 토큰이 필요합니다.`);
  process.exit(1);
}

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
    // IPv6 를 쓸 수 없는 PC 면 IPv4 만으로 동작
  });
  server.listen(PORT, host, () => {
    if (opened++) return;
    console.log(`승부예측 대시보드: http://localhost:${PORT}`);
    console.log(`  (열리지 않으면 http://127.0.0.1:${PORT})`);
    if (!LOOPBACK) {
      const lan = lanAddresses().map((a) => `http://${a.address}:${PORT}`).join(', ');
      console.log(`폰 모드: 같은 와이파이의 폰에서 접속 가능 (${lan || '내부 주소를 찾지 못함'})`);
      console.log('  PC에서 위 주소를 열고 오른쪽 위 "폰으로 보기"의 QR 코드를 폰 카메라로 찍으세요.');
      console.log('  Windows 방화벽 창이 뜨면 "허용"을 눌러야 폰에서 열립니다.');
    } else if (PHONE_MODE === false) {
      console.log('  폰에서도 보려면: npm run phone');
    }
    console.log(aiEnabled() ? `AI 분석 사용 가능 (${AI_MODEL})` : 'AI 분석 꺼짐 (ANTHROPIC_API_KEY 미설정) — 통계모델만 사용');
  });
}
