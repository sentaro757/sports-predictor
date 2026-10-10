// 팀 공식 홈페이지 뉴스 (RSS/Atom 피드). data/team-feeds.json 에 리그별·팀별 주소를 등록해서 사용
import fs from 'node:fs';
import path from 'node:path';
import { fetchCached } from '../http.js';
import { classify } from '../signals.js';

const FEEDS_FILE = path.join(import.meta.dirname, '..', '..', 'data', 'team-feeds.json');

// 기본 제공 피드: MLB 30개 구단 공식 뉴스 RSS (mlb.com/<구단>/feeds/news/rss.xml, robots.txt 허용 경로)
// 키는 ESPN 팀 ID. 다른 리그 구단은 공식 RSS가 없어 기본 제공하지 않는다 (README 참고)
const MLB_SLUGS = {
  29: 'dbacks', 11: 'athletics', 15: 'braves', 1: 'orioles', 2: 'redsox', 16: 'cubs', 4: 'whitesox', 17: 'reds',
  5: 'guardians', 27: 'rockies', 6: 'tigers', 18: 'astros', 7: 'royals', 3: 'angels', 19: 'dodgers', 28: 'marlins',
  8: 'brewers', 9: 'twins', 21: 'mets', 10: 'yankees', 22: 'phillies', 23: 'pirates', 25: 'padres', 26: 'giants',
  12: 'mariners', 24: 'cardinals', 30: 'rays', 13: 'rangers', 14: 'bluejays', 20: 'nationals',
};
const BUILTIN = {
  mlb: Object.fromEntries(Object.entries(MLB_SLUGS).map(([id, slug]) => [id, `https://www.mlb.com/${slug}/feeds/news/rss.xml`])),
};

/** 기본 피드 + data/team-feeds.json (사용자가 등록한 주소는 기본 피드에 더해진다) */
function loadFeeds(leagueId) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'))[leagueId] || {};
  } catch {}
  const merged = {};
  for (const src of [BUILTIN[leagueId] || {}, user]) {
    for (const [teamId, urls] of Object.entries(src)) {
      merged[teamId] = [...new Set([...(merged[teamId] || []), ...(Array.isArray(urls) ? urls : [urls])])];
    }
  }
  return merged;
}

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const atomLink = b.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const date = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date');
    return {
      title: tag(b, 'title'),
      summary: (tag(b, 'description') || tag(b, 'summary')).slice(0, 220),
      url: tag(b, 'link') || atomLink,
      date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
    };
  });
}

/** 해당 리그에 등록된 팀 공식 피드의 기사 목록 (teamIds 포함) */
export async function getTeamFeedNews(leagueId, warn) {
  const conf = loadFeeds(leagueId);
  let failed = 0;
  const jobs = Object.entries(conf).flatMap(([teamId, urls]) =>
    urls.map(async (url) => {
      try {
        const xml = await fetchCached(url, { ttl: 1800, type: 'text', warn });
        return parseFeed(xml)
          .filter((a) => a.title)
          .slice(0, 15) // 구단당 최근 15건
          .map((a) => ({
            ...a,
            title: a.title.slice(0, 200),
            source: '구단 공식',
            official: true,
            lang: /[가-힣]/.test(a.title) ? 'ko' : 'en',
            teamIds: [String(teamId)],
            tags: classify(`${a.title} ${a.summary}`),
          }));
      } catch (e) {
        failed++;
        console.warn(`[feed] ${url}: ${e.message}`);
        return [];
      }
    }),
  );
  const out = (await Promise.all(jobs)).flat();
  if (failed) warn?.(`구단 공식 피드 ${failed}곳 수집 실패`);
  return out;
}
