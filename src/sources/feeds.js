// 팀 공식 홈페이지 뉴스 (RSS/Atom 피드). data/team-feeds.json 에 리그별·팀별 주소를 등록해서 사용
import fs from 'node:fs';
import path from 'node:path';
import { fetchCached } from '../http.js';
import { classify } from '../signals.js';

const FEEDS_FILE = path.join(import.meta.dirname, '..', '..', 'data', 'team-feeds.json');

function loadFeeds() {
  try {
    return JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
  } catch {
    return {};
  }
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
export async function getTeamFeedNews(leagueId) {
  const conf = loadFeeds()[leagueId] || {};
  const jobs = Object.entries(conf).flatMap(([teamId, urls]) =>
    (Array.isArray(urls) ? urls : [urls]).map(async (url) => {
      try {
        const xml = await fetchCached(url, { ttl: 1800, type: 'text' });
        return parseFeed(xml).map((a) => ({
          ...a,
          source: '구단 공식',
          official: true,
          teamIds: [teamId],
          tags: classify(`${a.title} ${a.summary}`),
        }));
      } catch (e) {
        console.warn(`[feed] ${url}: ${e.message}`);
        return [];
      }
    }),
  );
  return (await Promise.all(jobs)).flat();
}
