import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PORT, HOST, ACCESS_TOKEN, AI_MODEL, AI_TAG_MODEL } from './src/config.js';
import { catalog, leagueOverview, gameDetail } from './src/service.js';
import { analyzeGame, aiEnabled, aiUsage } from './src/ai.js';
import { taggerEnabled } from './src/ai-tagger.js';
import { usageSummary } from './src/usage.js';
import { clearMemo } from './src/http.js';

const PUBLIC = path.join(import.meta.dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);

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
];

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** 요청 출처 검사. 실패하면 [상태코드, 메시지] */
function checkAccess(req) {
  const host = String(req.headers.host || '').toLowerCase();
  // 이 PC 전용 모드에서는 Host 헤더도 localhost 여야 한다 (DNS 리바인딩 차단)
  if (LOOPBACK && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return [403, '허용되지 않은 호스트'];
  // 다른 웹사이트가 브라우저를 통해 이 서버로 POST(유료 AI 실행 등)를 보내지 못하게 한다
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {}
    if (originHost !== host) return [403, '다른 사이트에서 온 요청은 허용하지 않습니다'];
  }
  if (ACCESS_TOKEN && !safeEqual(req.headers['x-access-token'] || '', ACCESS_TOKEN)) return [401, '접속 토큰이 필요합니다'];
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
        return json(res, 200, await handler(m.slice(1)));
      } catch (e) {
        console.error(`[api] ${url.pathname}:`, e.message);
        return json(res, e.status || 500, { error: e.message });
      }
    }
  }
  return json(res, 404, { error: 'not found' });
}

const onRequest = (req, res) => {
  handle(req, res).catch((e) => {
    console.error('[server] 요청 처리 오류:', e);
    if (!res.headersSent) json(res, 500, { error: '서버 오류' });
    else res.destroy();
  });
};

if (!LOOPBACK && !ACCESS_TOKEN) {
  console.error(`HOST=${HOST} 로 외부 접속을 열려면 ACCESS_TOKEN 도 설정해야 합니다.`);
  process.exit(1);
}

// 이 PC 전용 모드: 브라우저가 localhost 를 IPv4(127.0.0.1) 또는 IPv6(::1) 중 어느 쪽으로 찾아도 열리도록 둘 다 연다
const hosts = LOOPBACK ? ['127.0.0.1', '::1'] : [HOST];
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
    console.log(`승부예측 대시보드: http://${LOOPBACK ? 'localhost' : HOST}:${PORT}${ACCESS_TOKEN ? '/?token=<ACCESS_TOKEN>' : ''}`);
    if (LOOPBACK) console.log(`  (열리지 않으면 http://127.0.0.1:${PORT})`);
    console.log(aiEnabled() ? `AI 분석 사용 가능 (${AI_MODEL})` : 'AI 분석 꺼짐 (ANTHROPIC_API_KEY 미설정) — 통계모델만 사용');
  });
}
