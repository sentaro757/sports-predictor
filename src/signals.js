// 뉴스 제목/요약에서 부상·복귀·영입·방출·감독 신호를 키워드로 찾고,
// 그 신호가 "어느 팀"의 일인지 판단한다.
//  1) 신호 키워드가 있는 절(clause) 안에서만 대상을 찾는다
//  2) 선수 이름 → 소속팀 사전이 있으면 선수를 가장 강한 근거로 쓴다
//  3) 팀 이름은 조사/전치사로 역할(주체·상대팀)을 구분한다 ("삼성을 상대로" → 상대팀)
//  4) 근거가 애매하면 아무 팀에도 붙이지 않는다 (틀리게 붙이는 것보다 낫다)
// (AI 기사 분류를 켜면 Claude 판단이 이 규칙보다 우선한다 — src/ai-tagger.js)

const RULES = {
  injury: {
    ko: ['부상', '결장', '이탈', '말소', '수술', '골절', '파열', '염좌', '통증', '재활', '시즌아웃', '시즌 아웃', '출전 불가', '출전불가', '징계', '출장정지'],
    en: ['injury', 'injuries', 'injured', 'ruled out', 'out for', 'surgery', 'torn', 'fracture', 'sprain', 'sprained', 'strain', 'strained', 'sidelined', 'suspended', 'suspension', 'out indefinitely', 'unavailable', 'doubtful', 'misses out', 'will miss', 'injury-hit', 'knock', 'limps off', 'limped off'],
  },
  return: {
    ko: ['복귀', '돌아온', '합류', '콜업', '회복', '출전 가능'],
    en: ['returns', 'return', 'returned', 'returning', 'back from', 'back in training', 'cleared', 'activated', 'available', 'reinstated'],
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
    ko: ['경질', '사퇴', '사임', '해임', '퇴진', '떠난다', '떠나기로', '감독대행', '감독 선임', '새 감독', '지휘봉'],
    en: ['fired', 'sacked', 'resigns', 'resigned', 'parts ways', 'interim', 'appointed', 'dismissed'],
  },
};

// 전력에 영향을 주는 신호 (팀 보정에 쓰임)
const IMPACT = new Set(['injury', 'return', 'coach']);

// 부정 표현: 영어는 앞쪽, 한국어는 뒤쪽에 붙는다
const EN_NEG_BEFORE = /\b(not|no|never|unable to|won't|will not|isn't|aren't|wasn't|didn't|without|no timeline for)\b[^.!?;:]{0,40}$/;
// 부상 단어 앞의 "without"은 부정이 아니다 ("without injured Saka" = Saka 부상 결장)
const EN_NEG_BEFORE_INJURY = /\b(not|no|never|isn't|aren't|wasn't|didn't)\b[^.!?;:]{0,20}$/;
const KO_NEG_AFTER = /^.{0,6}(불발|무산|불투명|어렵|연기|미정|않|못|좌절)/;
const KO_INJURY_DISMISSED = /^.{0,8}(없이|없는|없다|털고|딛고|이겨|우려 씻|회복|피했|피해|아니)/; // "부상 없이", "큰 부상은 피했다"
const EN_INJURY_DISMISSED_BEFORE = /\b(despite|clear of)\s[^.;:]{0,60}$/; // "start despite ... injuries"
// 이미 지난 부상 설명 ("was recovering from a torn Achilles", "returned from a knee injury")
const EN_PAST_INJURY_BEFORE = /\b(was recovering from|had been recovering from|recovered from|returned from|returning from|back from)\s(a\s|an\s|his\s|her\s|their\s)?$/;
// "bounce back from a loss", "hit back from two goals down" 는 복귀가 아니다
const EN_RETURN_IDIOM_BEFORE = /\b(bounce|bounced|bounces|hit|hits|came|come|comes|fought|fight|fights)\s$/;
// 감독·코치가 주어인 복귀/부상 ("Napoli boss Allegri returns", "Elversberg coach cleared")는 선수 전력과 무관
const COACH_SUBJECT_BEFORE = /(감독|사령탑|manager|coach|boss)\s?([가-힣a-z.'-]+\s?){0,3}$/i;
const KO_RANK_RETURN = /(\d+위|선두|1위|정상|단독)\s?$/; // "3위 복귀"는 부상 복귀가 아니다
const COACH_CONTEXT = /감독|사령탑|manager|coach|boss|head coach/i;
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

/* ---------- 절(clause) 나누기 ---------- */
// 제목의 쉼표·말줄임표·따옴표·콜론·화살표, 영어의 as/after/while 등에서 끊는다
const CLAUSE_SPLIT = /[,;:|…→↑↓"“”\[\]()<>《》「」\n]|[‘’'](?!s\b)|\.{2,}|·{2,}|\s[-–—]\s|[.!?](?=\s|$)|\s(?:as|after|while|but|despite)\s/gi;

function clauses(text) {
  const spans = [];
  let start = 0;
  for (const m of text.matchAll(CLAUSE_SPLIT)) {
    if (m.index > start) spans.push([start, m.index]);
    start = m.index + m[0].length;
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans.filter(([a, b]) => text.slice(a, b).trim());
}

/* ---------- 요약문 정리: 사진 캡션·기자 표기 제거 ---------- */
// 사진 설명: 출처 표기, 또는 "30일 오후 ... 하고 있다." 형태의 문장
const CAPTION = /제공|ⓒ|사진|=연합뉴스|=뉴스1|기자\s?=|image@|\.jpg|포토|앵커|리포트|\(왼쪽|오른쪽\)|\d{4}\.\d{1,2}\.\d{1,2}|^\d{1,2}일\s?(오전|오후|저녁|밤)?\s?.*(있다|잇다|있는 모습)\.?$/;

export function cleanSummary(summary) {
  const s = String(summary || '')
    .replace(/^(\s*[[(<【][^\])>】]{0,40}[\])>】])+/g, ' ') // 앞쪽 [OSEN=...], (서울=뉴스1) 등
    .replace(/[[(][^\])]{0,60}(사진|제공|=뉴시스|=연합뉴스|=뉴스1|기자)[^\])]{0,60}[\])]/g, ' ') // 문장 중간의 (사진=...제공), [서울=뉴시스]
    .replace(/\*?재판매 및 DB 금지/g, ' ')
    .replace(/[가-힣]{2,4}\s?기자\s?=?/g, ' ')
    .replace(/◀[^▶]*▶/g, ' ');
  const sentences = s.split(/(?<=[.!?])\s+|(?<=다\.)/).map((x) => x.trim()).filter(Boolean);
  return sentences.filter((x) => !CAPTION.test(x)).slice(0, 2).join(' ');
}

/** 텍스트에서 신호 키워드 위치를 찾는다. 부정문은 뒤집거나 버린다. */
export function analyze(text) {
  const t = (text || '').toLowerCase();
  let hits = [];
  for (const [tag, { ko, en }] of Object.entries(RULES)) {
    for (const w of [...ko, ...en]) {
      const word = w.toLowerCase();
      for (const index of findAll(t, word)) {
        // 영어 단어는 단어 경계에서만 ("unavailable" 안의 "available" 같은 오탐 방지)
        if (isAscii(word) && /[a-z]/.test(t[index - 1] || '')) continue;
        // 끝도 경계에서만 ("knocking" 안의 "knock"). 형태 변화는 목록에 따로 넣는다
        if (isAscii(word) && /[a-z]$/.test(word) && /[a-z]/.test(t[index + word.length] || '')) continue;
        const before = t.slice(Math.max(0, index - 80), index);
        const after = t.slice(index + word.length, index + word.length + 12);
        const negated = isAscii(word)
          ? (tag === 'injury' ? EN_NEG_BEFORE_INJURY : EN_NEG_BEFORE).test(before)
          : KO_NEG_AFTER.test(after);
        if (tag === 'return' && !isAscii(word) && KO_RANK_RETURN.test(before)) continue;
        if (tag === 'return' && isAscii(word) && EN_RETURN_IDIOM_BEFORE.test(before)) continue;
        if ((tag === 'return' || tag === 'injury') && COACH_SUBJECT_BEFORE.test(before.slice(-30))) continue;
        if (tag === 'coach' && !COACH_CONTEXT.test(t.slice(Math.max(0, index - 30), index + word.length + 30))) continue;
        if (tag === 'return' && negated) hits.push({ tag: 'injury', index, len: word.length }); // "not available", "복귀 불발" → 악재
        else if (
          tag === 'injury' &&
          (negated || (isAscii(word)
            ? EN_INJURY_DISMISSED_BEFORE.test(before) || EN_PAST_INJURY_BEFORE.test(before)
            : KO_INJURY_DISMISSED.test(after)))
        )
          continue;
        else if (!negated) hits.push({ tag, index, len: word.length });
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

/* ---------- 팀·선수 찾기 ---------- */
function nameRegex(name) {
  const esc = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return isAscii(name) ? new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'g') : new RegExp(`(?<![가-힣a-z])${esc}`, 'g');
}

const regexCache = new Map();
function teamRegexes(team) {
  let r = regexCache.get(team);
  if (!r) {
    r = (team.aliases || []).filter((a) => a && a.length >= 2).map(nameRegex);
    regexCache.set(team, r);
  }
  return r;
}

/**
 * 선수 명단 → 이름 사전. 여러 팀에 같은 이름이 있으면 애매하므로 뺀다.
 * list: [{ name, teamId }]  (영어 이름은 성(last name)도 따로 넣으면 "Saka" 처럼 짧게 불러도 찾는다)
 */
export function buildRosterIndex(list) {
  const byName = new Map();
  for (const { name, teamId } of list || []) {
    const n = String(name || '').trim();
    if (n.length < 2 || (isAscii(n) && n.length < 4)) continue;
    const k = n.toLowerCase();
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(String(teamId));
  }
  const entries = [];
  for (const [k, teams] of byName) if (teams.size === 1) entries.push({ name: k, teamId: [...teams][0], re: nameRegex(k) });
  // 긴 이름 먼저 (성만 있는 항목보다 전체 이름 우선)
  entries.sort((a, b) => b.name.length - a.name.length);
  return { entries };
}

function findPlayers(t, roster) {
  const out = [];
  if (!roster?.entries?.length) return out;
  for (const e of roster.entries) {
    if (!t.includes(e.name)) continue;
    e.re.lastIndex = 0;
    for (const m of t.matchAll(e.re)) {
      // 이미 더 긴 이름으로 잡힌 위치 안이면 건너뛴다
      if (out.some((p) => m.index >= p.index && m.index < p.index + p.len)) continue;
      out.push({ teamId: e.teamId, index: m.index, len: m[0].length, kind: 'player', name: e.name });
    }
  }
  return out;
}

// 상대팀 표지: 한국어는 이름 뒤 조사, 영어는 이름 앞 전치사/동사
const KO_OPPONENT_AFTER = /^(전(?![력술략역문체반])|을|를|에(?!서)|에게|와|과|랑|한테|\s?상대|\s?맞대결)/;
const KO_SUBJECT_AFTER = /^(이|가|은|는|도|의|마저|까지|\s?(측|구단|주전|에이스|선발|감독|사령탑))/;
const EN_OPPONENT_BEFORE = /\b(vs\.?|v\.?|versus|against|over|beat|beats|to|at|face|faces|facing|host|hosts|hosting|visit|visits|with|ahead of|clash with|thrash|thrashed|past)\s+(the\s+)?$/;
const EN_SUBJECT_AFTER = /^('s|’s|\s(star|manager|boss|coach|striker|forward|defender|midfielder|goalkeeper|guard|pitcher|ace))/;

/** 텍스트에 등장하는 팀과 위치·역할 */
export function findMentions(text, teams) {
  const t = (text || '').toLowerCase();
  const out = [];
  for (const team of teams) {
    for (const re of teamRegexes(team)) {
      re.lastIndex = 0;
      for (const m of t.matchAll(re)) {
        const end = m.index + m[0].length;
        if (out.some((x) => x.teamId === team.id && x.index === m.index)) continue;
        const after = t.slice(end, end + 6);
        const before = t.slice(Math.max(0, m.index - 16), m.index);
        const ascii = isAscii(m[0]);
        const opponent = ascii ? EN_OPPONENT_BEFORE.test(before) : KO_OPPONENT_AFTER.test(after);
        const subject = ascii ? EN_SUBJECT_AFTER.test(t.slice(end, end + 12)) : KO_SUBJECT_AFTER.test(after);
        out.push({ teamId: team.id, index: m.index, len: m[0].length, kind: 'team', opponent, subject, vs: opponent });
      }
    }
  }
  // "NC 다이노스와"처럼 같은 팀 이름이 붙어 나오면 역할은 마지막 이름 뒤 조사로 정한다
  out.sort((a, b) => a.index - b.index);
  for (let i = out.length - 2; i >= 0; i--) {
    const a = out[i];
    const b = out[i + 1];
    if (a.teamId === b.teamId && b.index - (a.index + a.len) <= 1 && b.index > a.index) {
      a.opponent = a.vs = b.opponent;
      a.subject = b.subject;
    }
  }
  return out;
}

/**
 * 국내 기사의 "이탈로(제주)", "이명재(대전)" 표기 → 그 팀 선수로 인식.
 * 명단에 없는 신입·임대 선수도 잡을 수 있다.
 */
function findNameWithTeam(t, teams) {
  const out = [];
  for (const m of t.matchAll(/([가-힣a-z]{2,8})\(([^()]{1,12})\)/g)) {
    const inner = m[2].trim();
    const team = teams.find((tm) => (tm.aliases || []).some((a) => a.toLowerCase() === inner));
    if (team) out.push({ teamId: team.id, index: m.index, len: m[1].length, kind: 'player', name: m[1] });
  }
  return out;
}

/** 한 신호(hit)의 대상 팀(과 근거가 된 선수) 고르기. 근거가 애매하면 null */
function pickTarget(hit, entities) {
  const scored = new Map(); // teamId -> best score
  const playerOf = new Map(); // teamId -> 가장 높은 점수를 준 선수 이름
  for (const e of entities) {
    if (e.kind === 'team' && e.opponent) continue;
    const d = e.index < hit.index ? hit.index - (e.index + e.len) : e.index - (hit.index + hit.len);
    let s = e.kind === 'player' ? 6 : 2;
    if (e.subject) s += 2;
    if (d <= 2) s += 2; // 바로 붙어 있음 ("LG 주전 부상", "injured Saka", "injury-hit Liverpool")
    s += 2 * Math.exp(-Math.max(d, 0) / 20);
    if (s > (scored.get(e.teamId) ?? -Infinity)) {
      scored.set(e.teamId, s);
      playerOf.set(e.teamId, e.kind === 'player' ? e.name : null);
    }
  }
  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < 0.75) return null; // 비슷하면 판단 보류
  return { teamId: ranked[0][0], player: playerOf.get(ranked[0][0]) || null };
}

/**
 * 기사가 언급하는 팀(teamIds)과, 전력 신호가 실제로 해당하는 팀(impacts)을 구분한다.
 *  - taggedIds: API가 붙여준 팀 태그(ESPN). 있으면 그 팀들만 후보로 본다.
 *  - roster: buildRosterIndex() 결과 (선수 이름 → 소속팀)
 */
export function attribute(article, teams, taggedIds = [], roster = null) {
  const tagged = new Set(taggedIds);
  const candidates = tagged.size ? teams.filter((t) => tagged.has(t.id)) : teams;
  const title = String(article.title || '');
  const summary = cleanSummary(article.summary);
  const teamIds = new Set(tagged);
  const impacts = [];
  const orphanTitleTags = []; // 제목에 신호는 있는데 제목 안에 팀·선수가 전혀 없는 경우
  let summaryOwnTeams = new Set();

  // 제목과 요약을 각각 따로 본다 (요약 속 사진 설명이 제목 판단을 흐리지 않도록)
  for (const [part, isTitle] of [[title, true], [summary, false]]) {
    if (!part) continue;
    const t = part.toLowerCase();
    const mentions = findMentions(part, candidates);
    const players = [...findPlayers(t, roster), ...findNameWithTeam(t, candidates)];
    for (const m of [...mentions, ...players]) teamIds.add(m.teamId);
    const spans = clauses(t);
    const { hits } = analyze(part);
    const all = [...mentions, ...players];
    const usable = (pool) => pool.some((e) => !(e.kind === 'team' && e.opponent));
    if (!isTitle) summaryOwnTeams = new Set(all.filter((e) => !(e.kind === 'team' && e.opponent)).map((e) => e.teamId));
    for (const h of hits) {
      if (isTitle && IMPACT.has(h.tag) && !all.length) {
        orphanTitleTags.push(h.tag);
        continue;
      }
      if (!IMPACT.has(h.tag)) continue;
      // 키워드가 선수/팀 이름의 일부면 무시 ("이탈로" 선수 이름 속 "이탈")
      if (all.some((e) => h.index >= e.index && h.index < e.index + e.len)) continue;
      const ci = spans.findIndex(([a, b]) => h.index >= a && h.index < b);
      const inSpan = (i) => (e) => i >= 0 && i < spans.length && e.index >= spans[i][0] && e.index < spans[i][1];
      // 같은 절 → (없으면) 앞 절로 거슬러 올라감 (제목은 3개, 요약은 1개까지) → (제목이면) 바로 뒤 절
      let pool = all.filter(inSpan(ci));
      for (let back = 1; !usable(pool) && back <= (isTitle ? 3 : 1); back++) pool = all.filter(inSpan(ci - back));
      if (isTitle && !usable(pool)) pool = all.filter(inSpan(ci + 1));
      const target = pickTarget(h, pool);
      const teamId = target?.teamId;
      // 제목이 이미 이 팀에 대해 판단했으면 요약은 덧붙이지 않는다 (제목이 기사의 핵심 주장)
      if (!isTitle && impacts.some((x) => x.teamId === teamId && x.fromTitle)) continue;
      if (teamId && !impacts.some((x) => x.teamId === teamId && x.tag === h.tag)) impacts.push({ teamId, tag: h.tag, player: target.player, fromTitle: isTitle });
    }
  }
  // "김경문 감독의 마지막 인사…함께 떠난다"처럼 제목에 팀이 없으면, 요약에 (상대팀이 아닌) 팀이 하나뿐일 때 그 팀으로 본다
  if (orphanTitleTags.length && summaryOwnTeams.size === 1) {
    const [teamId] = summaryOwnTeams;
    for (const tag of new Set(orphanTitleTags)) {
      if (!impacts.some((x) => x.teamId === teamId && x.tag === tag)) impacts.push({ teamId, tag, fromTitle: true });
    }
  }
  const { tags } = analyze(`${title}\n${summary}`);
  return { teamIds: [...teamIds], tags, impacts: impacts.map(({ teamId, tag, player }) => ({ teamId, tag, player: player || null })), by: 'rule' };
}

/** 선수 이름 정규화: 영어는 성(마지막 단어)으로 ("Bukayo Saka" = "Saka"), 한국어는 공백 제거 */
function playerKey(name) {
  const s = String(name || '').toLowerCase().trim();
  if (!s) return '';
  return /^[a-z]/.test(s) ? s.split(/\s+/).at(-1) : s.replace(/\s+/g, '');
}

const kstDay = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);

/**
 * 최근 기사들에서 한 팀의 뉴스 신호를 계산한다. 기사 수가 아니라 "사건" 수를 센다.
 *  - 그 팀이 신호 대상(impacts)인 기사만 본다
 *  - 사건 = 선수 + 유형. 같은 선수의 부상 기사가 여러 건이어도 1건이다.
 *    같은 선수에게 부상과 복귀가 둘 다 있으면 가장 최근 기사 쪽을 따른다.
 *  - 선수를 알 수 없는 기사는 같은 날·같은 유형을 1건으로 묶는다
 *  - 감독 교체는 기간 내 1건
 *  - 구조화된 부상 명단이 있는 리그는 기사 속 부상은 세지 않는다 (명단과 중복)
 *  - 악재/호재 각각 최대 3건
 */
export function teamNewsSignal(articles, teamId, { ignoreInjury = false, sinceMs = 3 * 86400e3 } = {}) {
  const cutoff = Date.now() - sinceMs;
  const events = new Map(); // 사건 키 -> { tag, t }
  for (const a of articles) {
    if (!a.date || Date.parse(a.date) < cutoff) continue;
    const t = Date.parse(a.date);
    for (const x of a.impacts || []) {
      if (x.teamId !== teamId) continue;
      if (x.tag === 'injury' && ignoreInjury) continue;
      let key;
      if (x.tag === 'coach') key = 'coach';
      else if (x.tag === 'injury' || x.tag === 'return') {
        const p = playerKey(x.player);
        key = p ? `player:${p}` : `anon:${x.tag}:${kstDay(a.date)}`;
      } else continue;
      const prev = events.get(key);
      if (!prev || t > prev.t) events.set(key, { tag: x.tag, t });
    }
  }
  let neg = 0;
  let pos = 0;
  for (const { tag } of events.values()) {
    if (tag === 'return') pos++;
    else neg++;
  }
  neg = Math.min(neg, 3);
  pos = Math.min(pos, 3);
  return { neg, pos, net: pos - neg };
}
