// 뉴스 제목/요약에서 부상·복귀·영입·방출·감독 신호를 키워드로 찾고,
// 그 신호가 "어느 팀"의 일인지 판단한다.
// (AI 분석을 켜면 Claude가 기사 내용을 직접 해석하므로 이 규칙은 기본 보정용)

const RULES = {
  injury: {
    ko: ['부상', '결장', '이탈', '말소', '수술', '골절', '파열', '염좌', '통증', '재활', '시즌아웃', '시즌 아웃', '출전 불가', '출전불가', '징계', '출장정지'],
    en: ['injury', 'injured', 'ruled out', 'out for', 'surgery', 'torn', 'fracture', 'sprain', 'strain', 'sidelined', 'suspended', 'suspension', 'out indefinitely'],
  },
  return: {
    ko: ['복귀', '돌아온', '합류', '콜업', '회복', '출전 가능', '출격'],
    en: ['returns', 'return', 'back from', 'cleared', 'activated', 'available', 'reinstated'],
  },
  transfer: {
    ko: ['영입', '이적', '트레이드', 'FA', '계약', '임대', '입단', '재계약', '외국인 선수 교체', '교체 외국인'],
    en: ['signs ', 'signed', 'acquire', 'traded', 'trade for', 'transfer', 'on loan', 'contract extension'],
  },
  release: {
    ko: ['방출', '웨이버', '퇴단', '계약 해지', '결별', '은퇴'],
    en: ['waive', 'released', 'designated for assignment', 'retire'],
  },
  coach: {
    ko: ['경질', '사퇴', '감독 선임', '신임 감독', '감독대행'],
    en: ['fired', 'sacked', 'resigns', 'new manager', 'new coach', 'interim'],
  },
};

// 전력에 영향을 주는 신호 (팀 보정에 쓰임)
const IMPACT = new Set(['injury', 'return', 'coach']);

// 부정 표현: 영어는 앞쪽, 한국어는 뒤쪽에 붙는다
const EN_NEG_BEFORE = /\b(not|no|never|unable to|won't|will not|isn't|aren't|wasn't|didn't|without)\b[^.!?]{0,14}$/;
const KO_NEG_AFTER = /^.{0,6}(불발|무산|불투명|어렵|연기|미정|않|못|좌절)/;
const KO_INJURY_DISMISSED = /^.{0,6}(없이|없는|털고|딛고|이겨|우려 씻|회복)/; // "부상 없이", "부상 털고"
const isAscii = (w) => /^[\x00-\x7f]+$/.test(w);

function findAll(text, word) {
  const out = [];
  let i = text.indexOf(word);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(word, i + word.length);
  }
  return out;
}

/** 텍스트에서 신호 키워드 위치를 찾는다. 부정문은 뒤집거나 버린다. */
export function analyze(text) {
  const t = (text || '').toLowerCase();
  let hits = [];
  for (const [tag, { ko, en }] of Object.entries(RULES)) {
    for (const w of [...ko, ...en]) {
      const word = w.toLowerCase();
      for (const index of findAll(t, word)) {
        // 영어 단어는 단어 경계에서만 (signal 안의 "sign" 같은 오탐 방지)
        if (isAscii(word) && /[a-z]/.test(t[index - 1] || '')) continue;
        const before = t.slice(Math.max(0, index - 30), index);
        const after = t.slice(index + word.length, index + word.length + 12);
        const negated = isAscii(word) ? EN_NEG_BEFORE.test(before) : KO_NEG_AFTER.test(after);
        if (tag === 'return' && negated) hits.push({ tag: 'injury', index }); // "not available", "복귀 불발" → 악재
        else if (tag === 'injury' && (negated || (!isAscii(word) && KO_INJURY_DISMISSED.test(after)))) continue;
        else if (!negated) hits.push({ tag, index });
      }
    }
  }
  // "부상에서 복귀"처럼 부상 바로 뒤에 복귀가 오면 복귀 소식으로 본다
  const returns = hits.filter((h) => h.tag === 'return');
  hits = hits.filter((h) => !(h.tag === 'injury' && returns.some((r) => r.index > h.index && r.index - h.index <= 10)));
  hits.sort((a, b) => a.index - b.index);
  return { tags: [...new Set(hits.map((h) => h.tag))], hits };
}

export const classify = (text) => analyze(text).tags;

/** 별칭 하나를 경계 조건이 있는 정규식으로 */
function aliasRegex(alias) {
  const esc = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return isAscii(alias) ? new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'g') : new RegExp(`(?<![가-힣])${esc}`, 'g');
}

const regexCache = new Map();
function teamRegexes(team) {
  let r = regexCache.get(team);
  if (!r) {
    r = (team.aliases || []).filter((a) => a && a.length >= 2).map(aliasRegex);
    regexCache.set(team, r);
  }
  return r;
}

/** 텍스트에 등장하는 팀과 위치. vs=true 는 "삼성전"처럼 상대팀으로 언급된 경우 */
export function findMentions(text, teams) {
  const t = (text || '').toLowerCase();
  const out = [];
  for (const team of teams) {
    for (const re of teamRegexes(team)) {
      re.lastIndex = 0;
      for (const m of t.matchAll(re)) {
        const next = t.slice(m.index + m[0].length, m.index + m[0].length + 2);
        out.push({ teamId: team.id, index: m.index, vs: /^전(?![력술략역문체반])/.test(next) });
      }
    }
  }
  return out;
}

/**
 * 기사가 언급하는 팀(teamIds)과, 전력 신호가 실제로 해당하는 팀(impacts)을 구분한다.
 *  - taggedIds: API가 붙여준 팀 태그(ESPN). 있으면 그 팀들만 후보로 본다.
 *  - 신호 키워드 바로 앞에 나온 팀을 그 신호의 대상 팀으로 본다 ("삼성전 앞둔 LG 주전 부상" → LG)
 */
export function attribute(article, teams, taggedIds = []) {
  const text = `${article.title || ''}\n${article.summary || ''}`;
  const tagged = new Set(taggedIds);
  const candidates = tagged.size ? teams.filter((t) => tagged.has(t.id)) : teams;
  const mentions = findMentions(text, candidates);
  const teamIds = [...new Set([...tagged, ...mentions.map((m) => m.teamId)])];

  const { tags, hits } = analyze(text);
  const own = mentions.filter((m) => !m.vs);
  const ownTeams = [...new Set(own.map((m) => m.teamId))];
  const impacts = [];
  for (const h of hits) {
    if (!IMPACT.has(h.tag)) continue;
    const before = own.filter((m) => m.index < h.index && h.index - m.index <= 60).sort((a, b) => b.index - a.index)[0];
    const after = own.filter((m) => m.index > h.index && m.index - h.index <= 20).sort((a, b) => a.index - b.index)[0];
    const teamId =
      before?.teamId ?? after?.teamId ?? (ownTeams.length === 1 ? ownTeams[0] : teamIds.length === 1 ? teamIds[0] : null);
    if (teamId && !impacts.some((x) => x.teamId === teamId && x.tag === h.tag)) impacts.push({ teamId, tag: h.tag });
  }
  return { teamIds, tags, impacts };
}

/**
 * 최근 기사들에서 한 팀의 뉴스 신호를 계산한다.
 *  - 그 팀이 신호 대상(impacts)인 기사만 센다
 *  - 같은 사건을 다룬 기사(제목 앞부분이 같은 기사)는 한 번만
 *  - 구조화된 부상 명단이 있는 리그는 기사 속 부상은 세지 않는다 (명단과 중복)
 *  - 악재/호재 각각 최대 3건
 */
export function teamNewsSignal(articles, teamId, { ignoreInjury = false, sinceMs = 3 * 86400e3 } = {}) {
  const cutoff = Date.now() - sinceMs;
  const seen = new Set();
  let neg = 0;
  let pos = 0;
  for (const a of articles) {
    if (!a.date || Date.parse(a.date) < cutoff) continue;
    const mine = (a.impacts || []).filter((x) => x.teamId === teamId).map((x) => x.tag);
    if (!mine.length) continue;
    const key = (a.title || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '').slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    if (mine.includes('coach') || (!ignoreInjury && mine.includes('injury'))) neg++;
    if (mine.includes('return')) pos++;
  }
  neg = Math.min(neg, 3);
  pos = Math.min(pos, 3);
  return { neg, pos, net: pos - neg };
}
