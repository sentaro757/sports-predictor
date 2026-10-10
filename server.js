import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, AI_MODEL } from './src/config.js';
import { catalog, leagueOverview, gameDetail } from './src/service.js';
import { analyzeGame, aiEnabled } from './src/ai.js';
import { clearMemo } from './src/http.js';

const PUBLIC = path.join(import.meta.dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const routes = [
  ['GET', /^\/api\/catalog$/, () => ({ sports: catalog(), ai: { enabled: aiEnabled(), model: AI_MODEL } })],
  ['GET', /^\/api\/league\/([\w-]+)$/, ([id]) => leagueOverview(id)],
  ['GET', /^\/api\/game\/([\w-]+)\/([\w-]+)$/, ([l, g]) => gameDetail(l, g)],
  ['POST', /^\/api\/ai\/([\w-]+)\/([\w-]+)$/, ([l, g]) => analyzeGame(l, g)],
  ['POST', /^\/api\/refresh\/([\w-]+)$/, ([id]) => (clearMemo(`league:${id}`), leagueOverview(id))],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
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

  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`승부예측 대시보드: http://localhost:${PORT}`);
  console.log(aiEnabled() ? `AI 분석 사용 가능 (${AI_MODEL})` : 'AI 분석 꺼짐 (ANTHROPIC_API_KEY 미설정) — 통계모델만 사용');
});
