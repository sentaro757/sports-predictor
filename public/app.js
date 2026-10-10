const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const num = (x) => (Number.isFinite(Number(x)) ? String(Number(x)) : '-');
const signed = (x) => `${x > 0 ? '+' : ''}${Math.round(x)}`;

const TZ = 'Asia/Seoul';
const fmtTime = (d) => new Date(d).toLocaleTimeString('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDay = (d) => new Date(d).toLocaleDateString('ko-KR', { timeZone: TZ, month: 'long', day: 'numeric', weekday: 'short' });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('ko-KR', { timeZone: TZ, month: 'numeric', day: 'numeric' }) : '');
const ago = (d) => {
  if (!d) return '';
  const m = Math.round((Date.now() - Date.parse(d)) / 60000);
  if (m < 60) return `${Math.max(m, 1)}분 전`;
  if (m < 1440) return `${Math.round(m / 60)}시간 전`;
  return fmtDate(d);
};

const TAG_NAMES = { injury: '부상', return: '복귀', transfer: '영입', release: '방출', coach: '감독' };

const state = { catalog: null, sport: null, league: null, tab: 'games', data: null, ai: { enabled: false } };

// 서버를 ACCESS_TOKEN 과 함께 띄운 경우: 주소의 ?token= 값을 이 탭에 기억해 두고 요청마다 보낸다
function accessToken() {
  try {
    const t = new URLSearchParams(location.search).get('token');
    if (t) {
      sessionStorage.setItem('token', t);
      history.replaceState(null, '', location.pathname);
    }
    return sessionStorage.getItem('token') || '';
  } catch {
    return '';
  }
}
const TOKEN = accessToken();

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...(TOKEN ? { 'x-access-token': TOKEN } : {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function saveNav() {
  try {
    localStorage.setItem('nav', JSON.stringify({ sport: state.sport, league: state.league, tab: state.tab }));
  } catch {}
}
function loadNav() {
  try {
    return JSON.parse(localStorage.getItem('nav') || '{}');
  } catch {
    return {};
  }
}

/* ---------- 네비게이션 ---------- */
function renderSports() {
  $('#sports').innerHTML = state.catalog
    .map((s) => `<button data-sport="${s.id}" class="${s.id === state.sport ? 'active' : ''}">${s.icon} ${esc(s.name)}</button>`)
    .join('');
  const sport = state.catalog.find((s) => s.id === state.sport);
  $('#leagues').innerHTML = sport.leagues
    .map((l) => `<button data-league="${l.id}" class="${l.id === state.league ? 'active' : ''}">${esc(l.name)}</button>`)
    .join('');
}

function selectSport(id) {
  state.sport = id;
  state.league = state.catalog.find((s) => s.id === id).leagues[0].id;
  renderSports();
  loadLeague();
}

function selectLeague(id) {
  state.league = id;
  renderSports();
  loadLeague();
}

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  saveNav();
  renderContent();
}

async function loadLeague(refresh = false) {
  saveNav();
  const id = state.league;
  $('#league-title').textContent = '불러오는 중…';
  $('#league-meta').textContent = '';
  $('#content').innerHTML = '<div class="empty">데이터를 수집하고 있습니다. 처음에는 최대 10~20초 걸릴 수 있어요.</div>';
  try {
    const data = await api(refresh ? `/api/refresh/${id}` : `/api/league/${id}`, refresh ? { method: 'POST' } : undefined);
    if (state.league !== id) return;
    state.data = data;
    $('#league-title').textContent = data.league.name;
    const b = data.backtest;
    const bt = b
      ? ` · <span title="경기 직전의 Elo 레이팅과 홈 어드밴티지만으로 예측했을 때의 성적입니다. 폼·부상·뉴스 보정은 과거 시점 기록이 없어 검증에 포함되지 않습니다. 로그 손실은 낮을수록 좋습니다.">Elo+홈 백테스트 적중률 ${pct(b.accuracy)} (${esc(b.label)} ${b.games}경기, 로그손실 ${b.logLoss.toFixed(3)}) ⓘ</span>`
      : '';
    const warn = data.warnings?.length
      ? `<br><span class="warn-text">⚠ ${data.warnings.map(esc).join(' · ')}</span>`
      : '';
    const tg = data.tagging;
    const tagInfo = tg?.enabled && tg.ai ? ` · 기사 판단: AI ${tg.ai}건 / 규칙 ${tg.rule}건` : '';
    $('#league-meta').innerHTML = `분석 경기 ${data.gamesUsed.toLocaleString()}개${bt} · ${fmtTime(data.updatedAt)} 업데이트${tagInfo}${warn}`;
    renderContent();
    if (state.ai.tagging?.enabled) loadUsage(); // 기사 분류가 백그라운드로 돌았을 수 있음
  } catch (e) {
    $('#league-title').textContent = '오류';
    $('#content').innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
  }
}

/** 로딩 화면 없이 리그 데이터만 다시 받아 목록을 갱신 (AI 기사 분류 뒤) */
async function refreshLeagueQuietly() {
  const id = state.league;
  try {
    const data = await api(`/api/league/${id}`);
    if (state.league === id) {
      state.data = data;
      renderContent();
    }
  } catch {}
}

/* ---------- 탭 콘텐츠 ---------- */
const teamHtml = (t, extra = '') =>
  `<div class="team ${extra}">${t.logo ? `<img referrerpolicy="no-referrer" src="${safeUrl(t.logo)}" alt="" loading="lazy">` : ''}<span class="nm">${esc(t.name)}</span></div>`;

function probBar(p, soccer) {
  return `<div class="bar"><span class="h" style="width:${p.home * 100}%"></span>${
    soccer ? `<span class="d" style="width:${p.draw * 100}%"></span>` : ''
  }<span class="a" style="width:${p.away * 100}%"></span></div>
  <div class="bar-labels"><span class="h">홈 ${pct(p.home)}</span>${soccer ? `<span class="muted">무 ${pct(p.draw)}</span>` : ''}<span class="a">원정 ${pct(p.away)}</span></div>`;
}

function renderGames(d) {
  if (!d.games.length) return '<div class="empty">앞으로 7일 안에 예정된 경기가 없습니다.</div>';
  const soccer = d.league.sport === 'soccer';
  let html = '';
  let day = '';
  for (const g of d.games) {
    const dd = fmtDay(g.date);
    if (dd !== day) {
      day = dd;
      html += `<div class="day">${esc(dd)}</div>`;
    }
    const pick = g.prediction.pick;
    const alert = (n) => (n ? `<span class="alert">⚠ 부상 ${n}</span>` : '');
    // 홈팀을 항상 위에 (확률 막대도 홈 → 원정 순서). 굵은 글씨 + "우세" = 예측 승리팀
    const row = (side, label, extra = '') =>
      `<div class="team ${pick === side ? 'pick' : ''}">${g[side].logo ? `<img referrerpolicy="no-referrer" src="${safeUrl(g[side].logo)}" alt="" loading="lazy">` : ''}<span class="nm">${esc(g[side].name)}</span><span class="tag">${label}</span>${pick === side ? '<span class="tag fav">우세</span>' : ''}${extra}${alert(g.alerts[side])}</div>`;
    html += `<div class="card game" data-game="${esc(g.id)}">
      <div class="time">${g.status === 'live' ? '<span class="live">● LIVE</span>' : ''}${fmtTime(g.date)}</div>
      <div class="teams">
        ${row('home', '홈', g.preseason ? '<span class="tag pre">시범경기</span>' : '')}
        ${row('away', '원정')}
      </div>
      <div class="probs">${probBar(g.prediction.probs, soccer)}</div>
    </div>`;
  }
  return `<p class="note">경기를 누르면 근거(전력·폼·부상·뉴스)와 AI 분석을 볼 수 있습니다.</p>${html}`;
}

function renderResults(d) {
  if (!d.results.length) return '<div class="empty">최근 결과가 없습니다.</div>';
  return `<div class="card"><table><thead><tr><th>날짜</th><th>홈</th><th class="num">스코어</th><th>원정</th></tr></thead><tbody>${d.results
    .map(
      (g) => `<tr><td class="muted">${fmtDate(g.date)}</td><td>${esc(g.home.name)}</td>
      <td class="num"><b>${num(g.homeScore)} : ${num(g.awayScore)}</b></td><td>${esc(g.away.name)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

const formHtml = (f) => `<span class="form">${(f || []).map((r) => `<b class="${r}">${{ W: '승', L: '패', D: '무' }[r]}</b>`).join('')}</span>`;

function renderRankings(d) {
  return `<p class="note">Elo 레이팅: 모든 경기 결과(점수차 포함)로 계산한 전력 지수입니다. 1500이 리그 평균.</p>
  <div class="card"><table><thead><tr><th>#</th><th>팀</th><th class="num">Elo</th><th>최근 5경기</th></tr></thead><tbody>${d.rankings
    .map((t, i) => `<tr><td class="muted">${i + 1}</td><td>${teamHtml(t)}</td><td class="num"><b>${t.elo}</b></td><td>${formHtml(t.form)}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

const chips = (a) =>
  `<span class="chips">${a.official ? '<span class="chip official">구단 공식</span>' : ''}${(a.tags || [])
    .filter((t) => TAG_NAMES[t])
    .map((t) => `<span class="chip ${t}">${TAG_NAMES[t]}</span>`)
    .join('')}${a.by === 'ai' ? '<span class="chip ai" title="Claude가 기사 내용을 읽고 대상 팀과 사건을 분류했습니다">AI 판단</span>' : ''}</span>`;

const articleHtml = (a) => `<div class="card item">
  ${a.image ? `<img referrerpolicy="no-referrer" class="thumb" src="${safeUrl(a.image)}" alt="" loading="lazy">` : ''}
  <div><h4><a href="${safeUrl(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>${chips(a)}</h4>
  <p>${esc(a.summary)}</p><p class="small">${esc(a.source || '')} · ${ago(a.date)}</p></div></div>`;

function renderNews(d) {
  const main = d.news.length ? d.news.map(articleHtml).join('') : '<div class="empty">뉴스가 없습니다.</div>';
  const official = d.officialNews?.length
    ? `<div class="day">구단 공식 뉴스 (최신 ${d.officialNews.length}건 · 팀별 전체는 경기 상세에서)</div><div class="list">${d.officialNews.map(articleHtml).join('')}</div>`
    : '';
  const ko = d.koNews?.length
    ? `<div class="day">국내 언론 (해당 종목 해외 소식 전체)</div><div class="list">${d.koNews.map(articleHtml).join('')}</div>`
    : '';
  return `<div class="day">언론 보도</div><div class="list">${main}</div>${official}${ko}`;
}

function renderInjuries(d) {
  if (!d.injuries.length) return '<div class="empty">부상 소식이 없습니다.</div>';
  if (!d.injuriesStructured) {
    return `<p class="note">이 리그는 공개 부상자 명단이 없어, 최근 기사에서 부상·복귀 관련 소식을 자동으로 골라 보여줍니다.</p>
    <div class="list">${d.injuries.map(articleHtml).join('')}</div>`;
  }
  return `<div class="card"><table><thead><tr><th>팀</th><th>선수</th><th>상태</th><th>내용</th><th>날짜</th></tr></thead><tbody>${d.injuries
    .map(
      (i) => `<tr><td>${esc(i.teamName)}</td><td><b>${esc(i.player)}</b> <span class="muted small">${esc(i.position || '')}</span></td>
      <td><span class="chip injury">${esc(i.status)}</span>${i.returnDate ? `<div class="muted small">복귀 예정 ${fmtDate(i.returnDate)}</div>` : ''}</td><td class="small">${esc(i.detail)}</td><td class="muted small">${fmtDate(i.date)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function renderTransactions(d) {
  if (!d.transactions.length) return '<div class="empty">영입·방출 소식이 없습니다.</div>';
  if (!d.transactionsStructured) {
    return `<p class="note">최근 기사에서 영입·이적·방출 관련 소식을 자동으로 골라 보여줍니다.</p>
    <div class="list">${d.transactions.map(articleHtml).join('')}</div>`;
  }
  return `<div class="card"><table><thead><tr><th>날짜</th><th>팀</th><th>내용</th></tr></thead><tbody>${d.transactions
    .map(
      (t) => `<tr><td class="muted small">${fmtDate(t.date)}</td><td>${esc(t.teamName)}</td><td>${esc(t.description)} ${chips(t)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

const RENDER = { games: renderGames, results: renderResults, rankings: renderRankings, news: renderNews, injuries: renderInjuries, transactions: renderTransactions };

function renderContent() {
  if (!state.data) return;
  $('#content').innerHTML = RENDER[state.tab](state.data);
}

/* ---------- 경기 상세 ---------- */
function adjRow(label, v) {
  const r = Math.round(v);
  return `<div class="kv"><span>${label}</span><span class="${r > 0 ? 'pos' : r < 0 ? 'neg' : 'muted'}">${signed(v)}</span></div>`;
}

function sideBox(title, side, pr, hfa) {
  return `<div class="card box"><h4>${esc(side.team.name)} <span class="muted small">${title}</span></h4>
    <div class="kv"><span>Elo 전력</span><b>${Math.round(pr.elo)}</b></div>
    ${hfa ? adjRow('홈 어드밴티지', hfa) : ''}
    ${adjRow('최근 폼', pr.adj.form)}
    ${adjRow('부상자', pr.adj.injury)}
    ${adjRow(`뉴스 신호 (복귀 ${side.signal.pos} · 악재 ${side.signal.neg})`, pr.adj.news)}
    <div class="kv"><span>최근 5경기</span>${formHtml(pr.form)}</div></div>`;
}

const miniList = (items, f, empty = '없음') =>
  items.length ? `<ul class="mini">${items.map((x) => `<li>${f(x)}</li>`).join('')}</ul>` : `<p class="muted small">${empty}</p>`;

const linkLi = (a) => `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>${chips(a)} <span class="muted">${ago(a.date)}</span>`;

function teamColumn(side, structured) {
  const inj = structured
    ? miniList(side.injuries, (i) => `<b>${esc(i.player)}</b> <span class="chip injury">${esc(i.status)}</span> <span class="muted">${esc(i.detail)}</span>`)
    : '';
  return `<div class="card box"><h4>${esc(side.team.name)} <span class="muted small">팀 ID ${esc(side.team.id)}</span></h4>
    <div class="section"><h3>부상</h3>${inj}${miniList(side.injuryNews, linkLi, structured ? '' : '관련 기사 없음')}</div>
    <div class="section"><h3>영입·방출</h3>${miniList(side.transactions, (t) => (t.url ? linkLi(t) : `${esc(t.description)} <span class="muted">${fmtDate(t.date)}</span>`))}</div>
    <div class="section"><h3>팀 뉴스</h3>${miniList(side.news, linkLi, '최근 기사 없음')}</div></div>`;
}

/*
 * 상세 창(모달) 세대 번호. 창을 새로 열거나 닫을 때마다 올라간다.
 * 응답이 늦게 도착했을 때 요청 시점의 세대와 다르면 그 응답은 버린다
 * (A 경기 AI 분석 중에 B 경기를 열었는데 A 결과가 B 화면에 붙는 문제 방지).
 */
let modalSeq = 0;
const isCurrentModal = (seq) => seq === modalSeq && $('#detail').open;

async function openGame(gameId, aiResult = null, leagueId = state.league, seq = null) {
  const dlg = $('#detail');
  if (seq === null) {
    seq = ++modalSeq;
    $('#detail-body').innerHTML = '<div class="empty">불러오는 중…</div>';
  }
  if (!dlg.open) dlg.showModal();
  try {
    const d = await api(`/api/game/${leagueId}/${gameId}`);
    if (!isCurrentModal(seq)) return;
    const p = d.prediction;
    const soccer = d.league.sport === 'soccer';
    const g = d.game;
    $('#detail-body').innerHTML = `
      <p class="muted small">${esc(d.league.name)} · ${esc(fmtDay(g.date))} ${fmtTime(g.date)}</p>
      <div class="vs">
        <div>${g.home.logo ? `<img referrerpolicy="no-referrer" src="${safeUrl(g.home.logo)}" alt="">` : ''}<div class="nm">${esc(g.home.name)}</div><div class="muted small">홈${p.pick === 'home' ? ' · <b class="fav-text">우세</b>' : ''}</div><div class="big-prob h">${pct(p.probs.home)}</div></div>
        <div class="muted">${soccer ? `무승부<div class="big-prob">${pct(p.probs.draw)}</div>` : 'VS'}</div>
        <div>${g.away.logo ? `<img referrerpolicy="no-referrer" src="${safeUrl(g.away.logo)}" alt="">` : ''}<div class="nm">${esc(g.away.name)}</div><div class="muted small">원정${p.pick === 'away' ? ' · <b class="fav-text">우세</b>' : ''}</div><div class="big-prob a">${pct(p.probs.away)}</div></div>
      </div>
      ${probBar(p.probs, soccer)}
      <p class="note" style="margin-top:8px">순수 전력(Elo+홈)만 보면 홈 ${pct(p.baseProbs.home)}${soccer ? ` / 무 ${pct(p.baseProbs.draw)}` : ''} / 원정 ${pct(p.baseProbs.away)} → 폼·부상·뉴스 보정 후 위 확률</p>
      ${p.preseason ? '<p class="note warn-text">시범경기입니다. 주전 출전시간이 달라 확률을 50:50 쪽으로 절반 당겼습니다.</p>' : ''}
      ${p.newSeason ? '<p class="note">새 시즌 첫 경기 전이라 지난 시즌 레이팅을 평균 쪽으로 일부 되돌려 계산했습니다.</p>' : ''}

      <div class="section" id="ai-section">${aiSection(gameId)}</div>

      <div class="section"><h3>예측 근거</h3><div class="cols">${sideBox('홈', d.home, p.home, p.hfa)}${sideBox('원정', d.away, p.away, 0)}</div></div>

      <div class="section"><h3>최근 맞대결 <span class="muted small">(홈 : 원정)</span></h3>${miniList(
        d.h2h,
        (x) => `${fmtDate(x.date)} · ${esc(x.home.name)} <b>${num(x.homeScore)} : ${num(x.awayScore)}</b> ${esc(x.away.name)}`,
        '최근 맞대결 기록 없음',
      )}</div>

      <div class="section"><div class="cols">${teamColumn(d.home, d.injuriesStructured)}${teamColumn(d.away, d.injuriesStructured)}</div></div>`;
    if (aiResult) {
      $('#ai-section').innerHTML = aiResultHtml(aiResult, g);
      $('#ai-section').insertAdjacentHTML('afterbegin', '<p class="note">AI 기사 분류 결과를 반영해 아래 예측 근거와 팀별 기사도 다시 계산했습니다.</p>');
    }
    $('#ai-run')?.addEventListener('click', () => runAi(gameId, g, leagueId, seq));
  } catch (e) {
    if (isCurrentModal(seq)) $('#detail-body').innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
  }
}

/* ---------- AI 비용 ---------- */
const usd = (x) => (x >= 1 ? `$${x.toFixed(2)}` : `$${(x || 0).toFixed(x > 0 && x < 0.01 ? 4 : 3)}`);
const krw = (x) => `${Math.round(x || 0).toLocaleString()}원`;
const FEATURE_NAMES = { analysis: 'AI 분석 버튼', tagging: 'AI 기사 분류' };

async function loadUsage() {
  const c = state.ai;
  let u = null;
  try {
    u = await api('/api/usage');
  } catch {}
  state.usage = u;
  const mode = c.enabled ? 'AI 분석 사용 가능' : '통계모델 모드 (AI 꺼짐)';
  const cost = u ? ` · 비용 오늘 ${usd(u.today.cost)} / 이번 달 ${usd(u.month.cost)}` : '';
  $('#ai-status').innerHTML = `<button type="button" class="linklike" id="usage-open" title="AI 사용량과 비용 자세히 보기"><span class="dot"></span>${mode}${cost}</button>`;
  $('#usage-open').addEventListener('click', openUsage);
}

function usageTable(period) {
  const rows = Object.entries(period.byFeature).flatMap(([feature, models]) =>
    Object.entries(models).map(
      ([model, b]) => `<tr><td>${esc(FEATURE_NAMES[feature] || feature)}</td><td class="small">${esc(model)}</td>
      <td class="num">${b.calls}</td><td class="num">${b.input.toLocaleString()}</td><td class="num">${b.output.toLocaleString()}</td>
      <td class="num"><b>${usd(b.cost)}</b>${b.unpriced ? ' <span class="muted small">(가격 미등록 포함)</span>' : ''}</td></tr>`,
    ),
  );
  if (!rows.length) return '<p class="muted small">사용 기록이 없습니다.</p>';
  return `<div class="card"><table><thead><tr><th>기능</th><th>모델</th><th class="num">호출</th><th class="num">입력 토큰</th><th class="num">출력 토큰</th><th class="num">비용</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

async function openUsage() {
  const seq = ++modalSeq;
  $('#detail-body').innerHTML = '<div class="empty">불러오는 중…</div>';
  if (!$('#detail').open) $('#detail').showModal();
  await loadUsage();
  if (!isCurrentModal(seq)) return;
  const u = state.usage;
  const c = state.ai;
  $('#detail-body').innerHTML = u
    ? `<h2 style="margin-top:0">AI 사용량과 비용</h2>
      <p class="note">API 응답에 기록된 실제 토큰 수로 계산한 금액입니다(정가 기준). 원화는 1달러 = ${u.usdKrw.toLocaleString()}원으로 환산한 대략값이며, 실제 청구액은 Anthropic 콘솔에서 확인하세요.</p>
      <div class="cols">
        <div class="card box"><h4>오늘</h4><div class="big-prob">${usd(u.today.cost)}</div><div class="muted small">약 ${krw(u.today.krw)} · ${u.today.calls}회 호출</div></div>
        <div class="card box"><h4>이번 달</h4><div class="big-prob">${usd(u.month.cost)}</div><div class="muted small">약 ${krw(u.month.krw)} · ${u.month.calls}회 호출</div></div>
      </div>
      <div class="section"><h3>오늘 상세</h3>${usageTable(u.today)}</div>
      <div class="section"><h3>이번 달 상세</h3>${usageTable(u.month)}</div>
      <div class="section"><h3>현재 설정</h3><ul class="mini">
        <li>AI 분석 버튼: ${c.enabled ? esc(c.model) : '꺼짐 (ANTHROPIC_API_KEY 없음)'}</li>
        <li>AI 기사 분류: ${c.tagging?.enabled ? `${esc(c.tagging.model)} — AI 분석 버튼을 누를 때 그 경기 두 팀 기사만 먼저 분류` : c.enabled ? '꺼짐 (AI_TAG_ARTICLES=0)' : '꺼짐 (ANTHROPIC_API_KEY 없음)'}</li>
      </ul></div>`
    : '<div class="empty error">사용량을 불러오지 못했습니다.</div>';
}

function aiSection() {
  if (!state.ai.enabled) {
    return `<div class="card ai-box"><b>AI 뉴스 분석 (꺼짐)</b>
      <p class="muted small">ANTHROPIC_API_KEY 를 설정하고 서버를 다시 시작하면, Claude가 기사 내용을 읽고 확률을 보정하며 이유를 설명합니다.</p></div>`;
  }
  const tag = state.ai.tagging?.enabled
    ? `① ${esc(state.ai.tagging.model)}가 두 팀의 최근 기사를 먼저 분류하고(누가 다쳤는지·복귀했는지) ② ${esc(state.ai.model)}가 그 자료로 통계 예측을 보정합니다.`
    : `${esc(state.ai.model)}가 부상·이적·팀 기사 내용을 읽고 통계 예측을 보정합니다.`;
  return `<div class="card ai-box"><b>AI 뉴스 분석</b>
    <p class="muted small">${tag} 누를 때마다 API 요금이 발생합니다(실제 금액은 분석 후 표시).</p>
    <button id="ai-run" class="btn" type="button">AI 분석 실행</button></div>`;
}

const costLine = (label, c, model) =>
  `<div class="kv"><span>${label} <span class="muted small">${esc(model || '')}${c.calls ? ` · ${c.calls}회 · 입력 ${c.inputTokens.toLocaleString()} / 출력 ${c.outputTokens.toLocaleString()} 토큰` : ''}</span></span><span>${c.unpriced ? '가격 미등록 ' : ''}${usd(c.usd)}</span></div>`;

function aiResultHtml(r, g) {
  // 지금 보고 있는 리그가 아니라 그 경기의 리그 기준 (무승부 표시 여부)
  const soccer = state.catalog.find((s) => s.leagues.some((l) => l.id === g.league))?.id === 'soccer';
  const name = (s) => esc(s === 'home' ? g.home.name : g.away.name);
  const factors = (r.factors || []).filter((f) => f && (f.team === 'home' || f.team === 'away'));
  const srcLinks = (f) =>
    (f.sources || []).length
      ? ` <span class="muted small">— 근거: ${f.sources.map((x) => (x.url ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title))).join(', ')}</span>`
      : ' <span class="muted small">(근거 기사 미지정 — 참고만)</span>';
  const t = r.steps?.tagging;
  const tagNote = t?.enabled
    ? `기사 분류: 새로 ${t.tagged || 0}건${t.skipped ? `, 이미 분류된 ${t.skipped}건` : ''}${t.error ? ` (실패: ${esc(t.error)} — 규칙 기반 판단으로 분석)` : ''}`
    : '';
  const cost = r.cached
    ? '<p class="note">3시간 안에 분석한 같은 경기라 저장된 결과를 보여줍니다 — 이번에는 추가 비용 없음</p>'
    : r.cost
      ? `<div class="section"><h3>이번 분석 비용</h3>
        ${t?.enabled ? costLine('① 기사 분류', t.cost, t.model) : ''}
        ${costLine(t?.enabled ? '② 분석' : '분석', r.steps?.analysis?.cost || r.cost, r.steps?.analysis?.model)}
        <div class="kv"><b>합계</b><b>${usd(r.cost.usd)} <span class="muted small">(약 ${krw(r.cost.krw)})</span></b></div></div>`
      : '';
  return `<div class="card ai-box"><b>${r.fallback ? 'AI 분석 실패 — 통계모델 결과' : 'AI 분석 결과'}</b> <span class="muted small">${esc(r.model)}</span>
      <div style="margin:10px 0">${probBar(r.probs, soccer)}</div>
      <p>${esc(r.summary)}</p>
      ${r.clamped ? '<p class="note">AI가 제시한 확률이 통계 예측과 너무 달라 허용 범위(±15%p) 안으로 조정했습니다.</p>' : ''}
      ${factors.map((f) => `<div class="factor"><span class="${f.impact === '+' ? 'pos' : 'neg'}">${f.impact === '+' ? '▲' : '▼'}</span> <b>${name(f.team)}</b> ${esc(f.text)}${srcLinks(f)}</div>`).join('')}
      ${tagNote ? `<p class="note">${tagNote}</p>` : ''}
      ${cost}
    </div>`;
}

// 요청할 때의 리그·경기·창 세대를 고정해 두고, 응답이 왔을 때 모두 그대로일 때만 화면에 붙인다
async function runAi(gameId, g, leagueId, seq) {
  const btn = $('#ai-run');
  btn.disabled = true;
  btn.textContent = state.ai.tagging?.enabled ? '① 기사 분류 → ② 분석 중… (30초~1분)' : '분석 중… (30초 정도 걸릴 수 있어요)';
  try {
    const r = await api(`/api/ai/${leagueId}/${gameId}`, { method: 'POST' });
    loadUsage();
    // 기사 분류가 바뀌었으면 목록 승률도 바뀌므로 갱신 (현재 보고 있는 리그일 때만)
    const changed = r.steps?.tagging?.tagged || r.steps?.tagging?.waited;
    if (changed && state.league === leagueId) refreshLeagueQuietly();
    if (!isCurrentModal(seq)) return; // 창을 닫았거나 다른 경기를 열었으면 버린다
    if (changed) await openGame(gameId, r, leagueId, seq); // 예측 근거·팀별 기사도 다시 계산된 값으로
    else $('#ai-section').innerHTML = aiResultHtml(r, g);
  } catch (e) {
    if (!isCurrentModal(seq)) return;
    btn.disabled = false;
    btn.textContent = 'AI 분석 다시 시도';
    btn.insertAdjacentHTML('afterend', `<p class="error small">${esc(e.message)}</p>`);
  }
}

/* ---------- 시작 ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-sport],[data-league],[data-tab],[data-game]');
  if (!t) return;
  if (t.dataset.sport) selectSport(t.dataset.sport);
  else if (t.dataset.league) selectLeague(t.dataset.league);
  else if (t.dataset.tab) selectTab(t.dataset.tab);
  else if (t.dataset.game) openGame(t.dataset.game);
});
$('#refresh').addEventListener('click', () => loadLeague(true));
$('#detail').addEventListener('click', (e) => e.target === e.currentTarget && e.currentTarget.close());
$('#detail').addEventListener('close', () => modalSeq++); // 닫힌 창에 도착하는 늦은 응답은 버린다

(async function init() {
  const c = await api('/api/catalog');
  state.catalog = c.sports;
  state.ai = c.ai;
  $('#ai-status').className = `ai-status ${c.ai.enabled ? 'on' : ''}`;
  loadUsage();

  const nav = loadNav();
  const sport = state.catalog.find((s) => s.id === nav.sport) || state.catalog[0];
  state.sport = sport.id;
  state.league = sport.leagues.some((l) => l.id === nav.league) ? nav.league : sport.leagues[0].id;
  if (RENDER[nav.tab]) state.tab = nav.tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  renderSports();
  loadLeague();
})();
