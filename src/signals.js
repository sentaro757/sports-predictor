// 뉴스 제목/요약에서 부상·복귀·영입·방출 신호를 키워드로 분류한다.
// (AI 분석을 켜면 Claude가 기사 내용을 직접 해석하므로 이 규칙은 기본 보정용)

const RULES = {
  injury: {
    ko: ['부상', '결장', '이탈', '말소', '수술', '골절', '파열', '염좌', '통증', '재활', '시즌아웃', '시즌 아웃', '출전 불가', '출전불가', '징계', '퇴장 징계', '출장정지'],
    en: ['injury', 'injured', 'ruled out', 'out for', 'surgery', 'torn', 'fracture', 'sprain', 'strain', 'sidelined', 'suspended', 'suspension', 'out indefinitely', 'miss '],
  },
  return: {
    ko: ['복귀', '돌아온', '합류', '콜업', '등록', '회복', '출전 가능', '출격'],
    en: ['return', 'returns', 'back from', 'cleared', 'activated', 'available', 'reinstated'],
  },
  transfer: {
    ko: ['영입', '이적', '트레이드', 'FA', '계약', '임대', '입단', '재계약', '외국인 선수 교체', '교체 외국인'],
    en: ['signs ', 'signed', 'acquire', 'traded', 'trade for', 'transfer', 'on loan', 'contract extension'],
  },
  release: {
    ko: ['방출', '웨이버', '퇴단', '계약 해지', '결별', '은퇴', '방출 통보'],
    en: ['waive', 'released', 'designated for assignment', 'retire'],
  },
  coach: {
    ko: ['경질', '사퇴', '감독 선임', '신임 감독', '감독대행'],
    en: ['fired', 'sacked', 'resigns', 'new manager', 'new coach', 'interim'],
  },
};

const lowerHas = (text, words) => words.filter((w) => text.includes(w.toLowerCase()));

export function classify(text) {
  const t = (text || '').toLowerCase();
  const tags = [];
  for (const [tag, { ko, en }] of Object.entries(RULES)) {
    if (lowerHas(t, ko).length || lowerHas(t, en).length) tags.push(tag);
  }
  return tags;
}

/** 팀 이름(별칭)이 기사에 등장하는지 */
export function mentions(text, aliases) {
  const t = (text || '').toLowerCase();
  return aliases.some((a) => a && a.length >= 2 && t.includes(a.toLowerCase()));
}

/**
 * 최근 기사들에서 팀별 뉴스 신호 점수를 계산한다.
 * 부상/징계/감독경질 = 마이너스, 복귀 = 플러스.
 */
export function teamNewsSignal(articles, sinceMs = 3 * 86400e3) {
  const cutoff = Date.now() - sinceMs;
  let neg = 0;
  let pos = 0;
  const items = [];
  for (const a of articles) {
    if (a.date && Date.parse(a.date) < cutoff) continue;
    const tags = a.tags || [];
    if (tags.includes('injury')) neg++;
    if (tags.includes('coach')) neg++;
    if (tags.includes('return')) pos++;
    if (tags.length) items.push(a);
  }
  return { neg, pos, net: pos - neg, items };
}
