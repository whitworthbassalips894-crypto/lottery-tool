'use strict';
const SOURCE_URL = 'https://whitworthbassalips894-crypto.github.io/Number-selection-tool/data/draws.json';
const STORAGE_KEY = 'three_in_three_sync_v1';
// 版本号与 sw.js 缓存名一起提升，避免旧缓存与新代码混用。
const APP_BUILD = '2026.11.25-r14';
const HISTORY_PAGE = 50, SPECIAL_PAGE = 30, RECENT_WINDOW = 100;
// 检查更新只取上游文件开头一小段，读出 latestId / updatedAt 即可判断差几期。
const SOURCE_PROBE_RANGE = 'bytes=0-1023';
// 一位数号码输入后等待这么久没有继续输入，就自动跳到下一格（手机上省掉每格再点一次）。
const SINGLE_DIGIT_ADVANCE_MS = 700;

let records = [], replay = [], excluded = [], sourceUpdated = '', recommendation = null, builtinRecords = [];
let historyView = 'special', selectedScope = 'recent', expanded = '', query = '', onlyHit = false, quickFilter = 'all';
let historyLimit = HISTORY_PAGE, specialLimit = SPECIAL_PAGE;
let lastSync = null, upstream = null, rangeProbeOk = false, builtinLabel = '', builtinUpdated = '', initNote = '';
let followSince = '', editingManual = null;

const el = id => document.getElementById(id);
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wave = n => (typeof WAVE_MAP !== 'undefined' && WAVE_MAP[n]) || 'blue';
const WAVE_LABEL = { red: '红波', blue: '蓝波', green: '绿波' };
const money = n => { const v = Number(n || 0); return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toLocaleString('en-US'); };
// 每期期望值要精确到分：四舍五入成整数会把 -16.81 说成 -17，长期累计差很多。
const money2 = n => { const v = Number(n || 0); return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toFixed(2); };

/* ---------------- 号码渲染 ---------------- */
function ballHtml(n, opts) {
  const o = opts || {};
  const cls = ['ball', wave(n)];
  if (o.size) cls.push(o.size);
  if (o.hit) cls.push('ring-hit');
  if (o.special) cls.push('is-special');
  const ball = `<span class="${cls.join(' ')}">${pad2(n)}</span>`;
  if (!o.label) return ball;
  return `<span class="ball-wrap">${ball}<small class="ball-label${o.special ? ' special' : ''}">${esc(o.label)}</small></span>`;
}
function unknownBall(opts) {
  const o = opts || {};
  return `<span class="ball-wrap"><span class="ball ghost${o.size ? ' ' + o.size : ''}">--</span>${o.label ? `<small class="ball-label${o.special ? ' special' : ''}">${esc(o.label)}</small>` : ''}</span>`;
}
// 开奖 7 球：前 6 位平码 + 分隔符 + 第 7 位特码（放大、蓝圈、标注「特码」）
function drawBallsHtml(rec, opts) {
  const o = opts || {};
  const hitSet = o.hits ? new Set(o.hits) : null;
  const parts = rec.numbers.map((n, i) => ballHtml(n, {
    size: o.size, label: o.labels ? `正${i + 1}` : '', hit: hitSet ? hitSet.has(n) : false
  }));
  if (o.labels) parts.push('<span class="ball-plus" aria-hidden="true">+</span>');
  if (rec.special == null) parts.push(unknownBall({ size: o.specialSize || o.size, label: o.labels ? '特码' : '', special: true }));
  else parts.push(ballHtml(rec.special, {
    size: o.specialSize || o.size, label: o.labels ? '特码' : '', special: true,
    hit: o.markSpecialHit && rec.specialHit === true
  }));
  return parts.join('');
}
// 表格内的紧凑号码：平码用中性小块，特码用波色圆块 + 蓝圈，命中用琥珀色
function chipsHtml(rec, hitSet) {
  const nums = rec.numbers.map(n => `<span class="num${hitSet && hitSet.has(n) ? ' hit' : ''}">${pad2(n)}</span>`);
  const sp = rec.special == null
    ? '<span class="num unknown" title="该期特码未记录">--</span>'
    : `<span class="num special ${wave(rec.special)}${rec.specialHit ? ' hit' : ''}" title="第7位特码">${pad2(rec.special)}</span>`;
  return `<span class="nums">${nums.join('')}<span class="ball-plus" style="font-size:12px;padding:0 1px" aria-hidden="true">+</span>${sp}</span>`;
}
function specialLabel(rec) {
  if (rec.special == null) return '特码未记录';
  return `特码 ${pad2(rec.special)}（${WAVE_LABEL[wave(rec.special)]} · 生肖${zodiacOfNumber(rec.special, rec.date)}）`;
}

/* ---------------- 状态提示 ---------------- */
function status(message) { el('syncStatus').textContent = message; }
function flash(kind, message) {
  const box = el('manualFlash');
  if (!box) return;
  box.innerHTML = `<div class="info-box ${kind === 'ok' ? 'flash-ok' : 'flash-bad'}" role="status">${esc(message)}</div>`;
}
function showToast(message, kind) {
  try {
    const wrap = el('toastWrap');
    if (!wrap || typeof wrap.append !== 'function') return;
    const node = document.createElement('div');
    node.className = 'toast' + (kind ? ' ' + kind : '');
    node.textContent = message;
    wrap.append(node);
    setTimeout(() => { if (node && typeof node.remove === 'function') node.remove(); }, 2600);
  } catch (e) { /* toast 不是关键功能 */ }
}
// 本机数据是否已经落后于今天。目标期号的日期早于今天，说明本机停在过去的期次，
// 照着首屏的「下期目标期」去买就会买错期。这件事必须在首屏说，不能只写在页面最底部的同步卡里。
function staleness() {
  if (!records.length) return null;
  const last = records.at(-1);
  const p = parseLabel(nextLabelOf(last.label));
  if (!p) return null;
  const nextDate = periodToDate(p.year, p.periodNum);
  const days = daysBetween(nextDate, todayUTC());
  if (days == null) return null;
  return { stale: days > 0, days, nextDate, nextLabel: p.label, lastLabel: last.label, lastDate: last.date };
}
function renderStaleBanner() {
  const banner = el('staleBanner');
  if (!banner) return;
  const s = staleness();
  const stale = s && s.stale;
  const rec = el('recommendStale');
  banner.hidden = !stale;
  if (rec) rec.hidden = !stale;
  if (!stale) return;
  banner.innerHTML = `<b>⚠️ 本机数据已落后约 ${s.days} 天</b>：最新只到 ${esc(s.lastLabel)}（${esc(s.lastDate)}），`
    + `下面显示的「下期目标期 ${esc(s.nextLabel)}」是 ${esc(s.nextDate)} 那一期，早就开过了。`
    + `请先点<a href="#sync">数据同步</a>，核对期号后再购买。`;
  if (rec) rec.textContent = `⚠️ 目标期号 ${s.nextLabel} 对应 ${s.nextDate}，已过期约 ${s.days} 天。号码本身固定不变，但请先同步确认当前真正的期号。`;
}
function renderDecisionBanner() {
  const box = el('decisionBanner');
  if (!box) return;
  if (!records.length) { box.hidden = true; return; }
  const s = staleness();
  const last = records.at(-1);
  const pending = upstream && last && upstream.label > last.label ? countPeriodsBetween(last.label, upstream.label) : 0;
  let kind = 'ok', icon = '✅', text = '', action = '';
  if (s && s.stale) {
    kind = 'danger'; icon = '⚠️';
    text = `数据落后 ${s.days} 天，当前显示的目标期 ${esc(s.nextLabel)} 已过期。先同步再核对期号。`;
    action = `<a class="btn primary sm" href="#sync">去同步</a>`;
  } else if (pending > 0) {
    kind = 'warn'; icon = '🔔';
    text = `上游有 ${pending} 期可同步，本机最新 ${esc(last.label)}。同步后再复制号码。`;
    action = `<button class="btn primary sm" id="decisionSyncBtn" type="button">同步 ${pending} 期</button>`;
  } else {
    kind = 'ok'; icon = '✅';
    text = `数据状态正常：本机最新 ${esc(last.label)}（${esc(last.date)}），目标期 ${esc(recommendation ? recommendation.label : nextLabelOf(last.label))} 可直接复制固定 7 码。`;
    action = `<button class="btn primary sm" id="decisionCopyBtn" type="button">复制7码</button>`;
  }
  box.className = 'status-banner ' + kind;
  box.hidden = false;
  box.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${icon} ${text}</span><span class="spacer"></span>${action}`;
  const syncBtn = el('decisionSyncBtn');
  if (syncBtn && syncBtn.addEventListener) syncBtn.addEventListener('click', () => { const b = el('syncBtn'); if (b && !b.disabled && typeof b.click === 'function') b.click(); });
  const copyBtn = el('decisionCopyBtn');
  if (copyBtn && copyBtn.addEventListener) copyBtn.addEventListener('click', () => { const b = el('copyBtn'); if (b && !b.disabled && typeof b.click === 'function') b.click(); });
}
function renderSyncStrip() {
  const strip = el('syncStrip');
  if (!strip) return;
  const last = records.length ? records.at(-1) : null;
  const ahead = upstream && last ? upstream.label < last.label : false;
  const pending = upstream && last && !ahead ? countPeriodsBetween(last.label, upstream.label) : null;
  const cells = [
    { k: '本机最新期', v: last ? last.label : '--', s: last ? `${last.date} · 特码 ${last.special == null ? '未记录' : pad2(last.special)}` : '尚无数据', accent: true },
    { k: '内置快照', v: builtinLabel || '--', s: '更新于 ' + fmtStamp(builtinUpdated) },
    { k: '上游最新期', v: upstream ? upstream.label : '未检查', s: upstream ? '更新于 ' + fmtStamp(upstream.updatedAt) : '点「检查更新」或「一键同步」', alert: pending > 0 },
    { k: ahead ? '本机已超前上游' : '上次同步', v: lastSync ? lastSync.text : '尚未同步', s: lastSync ? fmtStamp(lastSync.at) : (upstream ? '' : '本机数据来自内置快照') }
  ];
  strip.innerHTML = cells.map(c =>
    `<div class="stat-cell${c.accent ? ' accent' : ''}${c.alert ? ' alert' : ''}"><div class="k">${esc(c.k)}</div><div class="v">${esc(c.v)}</div><div class="s">${esc(c.s)}</div></div>`).join('');
  if (typeof renderDecisionBanner === 'function') renderDecisionBanner();
}
function setSyncHint(text) {
  const hint = el('syncHint'), btn = el('syncBtn');
  if (hint) { hint.textContent = text || ''; hint.hidden = !text; }
  if (btn) btn.className = text ? 'btn primary attention' : 'btn primary';
}
function describeState(extra) {
  if (!records.length) return;
  const last = records.at(-1);
  const manual = manualRecords(records);
  const parts = [`当前最新有效期 ${last.label}（${last.date}）${last.special == null ? '，该期特码未记录' : '，特码 ' + pad2(last.special)}。`];
  if (manual.length) parts.push(`本机手动补录 ${manual.length} 条，最新 ${manual.at(-1).label}；可用「撤销上条手动」回退。`);
  parts.push(`内置快照到 ${builtinLabel || '--'}（更新于 ${fmtStamp(builtinUpdated)}）；想确认上游有没有新期次，点「检查更新」（约 1 KB，不写入），要写入再点「一键同步」。`);
  if (excluded.length) parts.push(`${excluded.length} 期前6码无效未参与统计：${excluded.slice(0, 8).join('、')}。`);
  if (extra) parts.push(extra);
  status(withNote(parts.join('\n')));
}
function persist() {
  const payload = storagePayload(records, sourceUpdated, excluded, { followSince });
  // 附加信息：上次同步结果与「上游是否支持分段请求」，normalizeSource 会忽略这两个键。
  payload.lastSync = lastSync;
  payload.rangeOk = rangeProbeOk;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}
function persistMeta() {
  if (!records.length) return;
  try { persist(); } catch (e) { /* 仅为附加信息，写不进去不影响使用 */ }
}
function withNote(message) { return initNote ? message + '\n' + initNote : message; }
function fmtStamp(iso) {
  if (!iso) return '未知时间';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
// 从 fromLabel 逐期推到 toLabel，算出相差几期；推不到（倒退或跨年异常）返回 null。
function countPeriodsBetween(fromLabel, toLabel, cap) {
  const limit = cap || 400;
  if (!fromLabel || !toLabel) return null;
  if (fromLabel === toLabel) return 0;
  let cur = fromLabel;
  for (let i = 1; i <= limit; i++) {
    cur = nextLabelOf(cur);
    if (!cur || cur > toLabel) return null;
    if (cur === toLabel) return i;
  }
  return null;
}
function safePersist() {
  try { persist(); return ''; } catch (e) { return '\n本机存储写入失败，改动只在当前页面有效：' + (e.message || e); }
}

/* ---------------- 推荐 ---------------- */
function createRecommendation(rows) {
  const label = nextLabelOf(rows.at(-1).label), p = parseLabel(label);
  const plan = run3in3At(rows, rows.length, p.year, p.periodNum, periodToDate(p.year, p.periodNum));
  // 固定 7 码：号码写死在 engine.js 的 FIXED_SEVEN，不随期号或历史变化
  return { label, numbers: plan.opt, picks: plan.picks, date: plan.date };
}
function recommendDetailHtml(rec) {
  if (!rec.picks || rec.picks.length !== 7) return '';
  // 逐号波色/生肖模块已按需求移除，保留函数以兼容调用点
  return '';
}
function compositionHtml(nums) {
  if (!nums || nums.length !== 7) return '';
  const w = { red: 0, blue: 0, green: 0 };
  const z = [0, 0, 0];
  let odd = 0;
  const tails = new Set();
  for (const n of nums) { w[wave(n)]++; z[zoneOf(n) - 1]++; if (n % 2 === 1) odd++; tails.add(n % 10); }
  return [
    `波色 红<b>${w.red}</b> 蓝<b>${w.blue}</b> 绿<b>${w.green}</b>`,
    `区间 01-16<b>${z[0]}</b> · 17-33<b>${z[1]}</b> · 34-49<b>${z[2]}</b>`,
    `单双 单<b>${odd}</b> 双<b>${7 - odd}</b>`,
    `尾数 <b>${tails.size}</b> 个`
  ].map(t => `<span class="chip">${t}</span>`).join('');
}

/* ---------------- 回放统计辅助 ---------------- */
function annotateStreaks() {
  let run = 0;
  for (const r of replay) {
    if (r.specialHit == null) { r.missRun = null; continue; }
    run = r.specialHit ? 0 : run + 1;
    r.missRun = run;
  }
}
function scopeRows() {
  if (selectedScope === 'all') return replay.slice();
  return selectedScope === 'recent' ? replay.slice(-RECENT_WINDOW) : replay.filter(r => String(r.year) === selectedScope);
}
// 搜索支持三种口径：期号、开奖日期、开奖号码（平码或特码）。
// 旧实现只匹配期号字符串，于是搜「07」会返回期号里含 "07" 的那一期——结果看着合理、含义完全错，
// 用户根本没机会怀疑。现在三种口径都匹配，并把各自命中几期写清楚。
function searchBreakdown(rows, q) {
  const text = q.trim();
  if (!text) return { rows: rows.slice(), label: '', byLabel: 0, byNumber: 0, byDate: 0 };
  const isNum = /^\d{1,2}$/.test(text);
  const want = isNum ? Number(text) : null;
  // 只有查询里带分隔符才当日期搜：否则搜「07」会把 07 月、07 日的期次一起捞进来，
  // 看着像号码命中，其实是日期命中。
  const looksLikeDate = /[-/年月]/.test(text);
  const slash = text.replaceAll('-', '/').replaceAll('年', '-').replaceAll('月', '-').replace(/日$/, '');
  let byLabel = 0, byNumber = 0, byDate = 0;
  const hit = rows.filter(r => {
    let matched = false;
    if (r.label.includes(text)) { byLabel++; matched = true; }
    if (looksLikeDate && r.date && (r.date.includes(text) || r.date.replaceAll('-', '/').includes(slash))) { byDate++; matched = true; }
    if (want != null && (r.numbers.includes(want) || r.special === want)) { byNumber++; matched = true; }
    return matched;
  });
  const parts = [];
  if (byLabel) parts.push(`期号 ${byLabel} 期`);
  if (byNumber) parts.push(`开出号码 ${String(want).padStart(2, '0')} 共 ${byNumber} 期`);
  if (byDate) parts.push(`日期 ${byDate} 期`);
  return { rows: hit, label: parts.join(' · '), byLabel, byNumber, byDate };
}
function filteredRows(base) {
  let rows = searchBreakdown(base, query).rows;
  if (onlyHit) rows = rows.filter(r => (historyView === 'special' ? r.specialHit === true : r.triples > 0));
  if (quickFilter && quickFilter !== 'all') {
    if (quickFilter === 'hit') rows = rows.filter(r => historyView === 'special' ? r.specialHit === true : r.triples > 0);
    else if (quickFilter === 'miss') rows = rows.filter(r => historyView === 'special' ? r.specialHit === false : r.triples === 0);
    else if (quickFilter === 'hit4') rows = rows.filter(r => (r.hits ? r.hits.length : 0) >= 4);
    else if (quickFilter === 'spHit') rows = rows.filter(r => r.specialHit === true);
    else if (quickFilter === 'streak10') rows = rows.filter(r => historyView === 'special' ? (r.missRun != null && r.missRun >= 10) : r.triples === 0);
  }
  return rows;
}

/* ---------------- 渲染 ---------------- */
function render() {
  if (!records.length) return;
  const last = records.at(-1);
  el('totalCount').textContent = records.length;
  el('buildTag').textContent = APP_BUILD;
  el('footerBuild').textContent = `版本 ${APP_BUILD} · 内置快照 ${sourceUpdated ? sourceUpdated.slice(0, 10) : '--'} · 数据源 whitworthbassalips894-crypto/Number-selection-tool`;
  el('latestIssue').textContent = last.label;
  el('latestDate').textContent = last.date || '';
  el('latestMeta').textContent = last.special == null ? '第 1~6 位平码 · 该期特码未记录' : `第 1~6 位平码 + 第 7 位特码 ${pad2(last.special)}`;
  el('latestBalls').innerHTML = drawBallsHtml(last, { labels: true, size: 'lg', specialSize: 'lg' });
  recommendation = createRecommendation(records);
  replay = buildReplay(records);
  annotateStreaks();
  renderStaleBanner();
  renderStatStrip();
  renderRecommendation();
  renderHistory();
  renderLedger();
  renderSpecialList();
  renderManualState();
  renderSyncStrip();
  renderDecisionBanner();
}
function renderStatStrip() {
  const recent = replay.slice(-RECENT_WINDOW);
  const s3 = summarizeReplay(recent), sp = summarizeSpecial(recent);
  const last = records.at(-1);
  const cells = [
    { k: '有效期开奖', v: String(records.length), s: '期' },
    { k: '最新有效期', v: last.label, s: last.date || '', accent: true },
    { k: '下期目标期', v: recommendation.label, s: recommendation.numbers.length === 7 ? '7码已生成' : '有效历史不足' },
    { k: `近${recent.length}期三中三有奖`, v: s3.winningRate.toFixed(1) + '%', s: `${s3.winningPeriods} / ${s3.periods} 期` },
    { k: `近${recent.length}期7码中特`, v: sp.rate.toFixed(1) + '%', s: `${sp.wins} / ${sp.periods} 期` }
  ];
  el('statStrip').innerHTML = cells.map(c =>
    `<div class="stat-cell${c.accent ? ' accent' : ''}"><div class="k">${esc(c.k)}</div><div class="v">${esc(c.v)} <small>${esc(c.s)}</small></div></div>`).join('');
}
function renderRecommendation() {
  const nums = recommendation.numbers;
  el('targetIssue').textContent = recommendation.label;
  el('copyBtn').disabled = nums.length !== 7;
  el('recommendBalls').innerHTML = nums.length === 7
    ? nums.map(n => ballHtml(n, { size: 'lg' })).join('')
    : '<span class="note">有效历史不足，暂无法生成完整 7 码，请同步更多数据。</span>';
  el('recommendComposition').innerHTML = compositionHtml(nums);
  el('recommendPicks').innerHTML = recommendDetailHtml(recommendation);
  const copyText = el('recommendCopyText');
  if (copyText) copyText.textContent = nums.length === 7 ? nums.map(pad2).join('，') : '--';
}
function renderSpecialList() {
  const rows = records.slice().reverse();
  const shown = rows.slice(0, specialLimit);
  const hitLabels = new Set(replay.filter(r => r.specialHit).map(r => r.label));
  el('specialList').innerHTML = shown.map(r => {
    const hit = hitLabels.has(r.label);
    const ball = r.special == null ? '<span class="ball sm ghost">--</span>' : ballHtml(r.special, { size: 'sm' });
    const meta = r.special == null ? '未记录' : `<span class="sp-date">${esc((r.date || '').slice(5))}<br></span>${esc(zodiacOfNumber(r.special, r.date))}${hit ? '<br><b>7码中特</b>' : ''}`;
    return `<div class="special-item${hit ? ' hit' : ''}" title="${esc(r.label)} 第7位特码${r.special == null ? '未记录' : ' ' + pad2(r.special)}${hit ? ' · 主推7码命中' : ''}">
      <span class="sp-period">${esc(r.label)}</span>${ball}<span class="sp-meta">${meta}</span></div>`;
  }).join('') || '<p class="note">暂无有效开奖数据。</p>';
  const withSpecial = records.filter(r => r.special != null).length;
  el('specialCount').textContent = `共 ${records.length} 期 · 已记录特码 ${withSpecial} 期 · 显示 ${shown.length} 期`;
  const specialDone = rows.length > 0 && specialLimit >= rows.length;
  el('specialMore').hidden = specialDone;
  el('specialAll').hidden = !specialDone;
  el('specialAll').textContent = specialDone ? `已全部加载 ${rows.length} 期` : '';
}
function renderManualState() {
  const manual = manualRecords(records);
  el('manualCount').textContent = `手动记录 ${manual.length} 条`;
  el('manualUndo').disabled = !manual.length;
  const editBtn = el('manualEdit');
  // 只有当最后一条就是手动记录时才能改：中间的手动记录后面已经接了新期次，改动会对不上账。
  if (editBtn) editBtn.disabled = !manual.length || records.at(-1).label !== manual.at(-1).label;
  const labelInput = el('manualLabel');
  if (labelInput && !String(labelInput.value || '').trim()) {
    labelInput.value = records.length ? nextLabelOf(records.at(-1).label) : '';
  }
  syncManualDate();
}
function rollingRate(rows, window, pred) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = rows.slice(start, i + 1);
    const wins = slice.filter(pred).length;
    out.push({ label: rows[i].label, rate: wins / slice.length * 100 });
  }
  return out;
}
function renderHistoryViz(base, s3, sp) {
  const box = el('historyViz');
  if (!box) return;
  const rows = base.slice(-120);
  if (!rows.length) { box.innerHTML = '<p class="note">暂无数据</p>'; return; }
  const isSpecial = historyView === 'special';
  const winPred = isSpecial ? (r => r.specialHit === true) : (r => r.triples > 0);
  const baseline = isSpecial ? sp.baseline : s3.baselineWinningRate;
  const winLabel = isSpecial ? '特码命中' : '三中三有奖';
  const timeline = rows.map(r => {
    const w3 = r.triples > 0, wsp = r.specialHit === true;
    const cls = ['hit-cell'];
    if (w3) cls.push('win3');
    if (wsp) cls.push('win-sp');
    const tip = `${r.label} · 平码命中${(r.hits||[]).length} · ${r.triples}组${r.specialHit==null?' · 特码未记':(r.specialHit?' · 7码中特':' · 特码未中')}`;
    return `<span class="${cls.join(' ')}" data-tip="${esc(tip)}" aria-label="${esc(tip)}"></span>`;
  }).join('');

  const roll = rollingRate(base, 20, winPred).slice(-120);
  const W = 600, H = 120, pad = { l: 34, r: 8, t: 10, b: 20 };
  const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
  const maxY = Math.max(baseline * 2, ...roll.map(p => p.rate), 10);
  const x = i => pad.l + (roll.length <= 1 ? 0 : i / (roll.length - 1) * innerW);
  const y = v => pad.t + innerH - (v / maxY) * innerH;
  const path = roll.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.rate).toFixed(1)}`).join(' ');
  const baseY = y(baseline);
  const grid = [0, baseline, Math.round(maxY)].map(v => `<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${W-pad.r}" y2="${y(v).toFixed(1)}" stroke="${v===baseline?'#94a3b8':'#e2e8f0'}" stroke-dasharray="${v===baseline?'4 4':'2 4'}"/><text x="${pad.l-4}" y="${(y(v)+3).toFixed(1)}" text-anchor="end" font-size="9" fill="#64748b">${v.toFixed(0)}%</text>`).join('');
  const area = roll.length ? `${path} L${x(roll.length-1).toFixed(1)} ${(pad.t+innerH).toFixed(1)} L${x(0).toFixed(1)} ${(pad.t+innerH).toFixed(1)} Z` : '';

  const missCur = isSpecial ? sp.currentMiss : (base.length ? (() => { let c=0; for(let i=base.length-1;i>=0;i--){ if(base[i].triples>0) break; c++; } return c; })() : 0);
  const missMax = isSpecial ? sp.maxMiss : Math.max(0, ...(() => { let m=0,run=0; for(const r of base){ if(r.triples>0){ if(run>m)m=run; run=0; } else run++; } if(run>m)m=run; return [m]; })());
  const pBase = isSpecial ? sp.baseline/100 : s3.baselineWinningRate/100;
  const q50 = missRunQuantile(pBase, 0.5) || 0;
  const q95 = missRunQuantile(pBase, 0.05) || 1;
  const missScale = Math.max(missMax, q95, missCur, 1);
  const mark = (v, label) => `<span class="mark" style="left:${Math.min(100, v/missScale*100)}%" data-label="${esc(label)}"></span>`;

  box.innerHTML = `
    <div class="viz-head">
      <span>最近 ${rows.length} 期命中时间轴</span>
      <span class="legend"><span><i style="background:#f59e0b"></i>三中三有奖</span><span><i style="background:#e2e8f0;box-shadow:inset 0 0 0 2px #2563eb"></i>7码中特</span><span><i style="background:#e2e8f0"></i>未中</span></span>
    </div>
    <div class="hit-timeline" aria-label="最近${rows.length}期命中时间轴">${timeline}</div>
    <div class="viz-head" style="margin-top:12px"><span>20期滚动${winLabel}率</span><span class="legend"><span><i style="background:#2563eb"></i>滚动率</span><span><i style="background:#94a3b8"></i>理论基线 ${baseline.toFixed(1)}%</span></span></div>
    <svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="20期滚动${esc(winLabel)}率">
      ${grid}
      <path d="${area}" fill="rgba(37,99,235,.10)" stroke="none"></path>
      <path d="${path}" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></path>
    </svg>
    <div class="viz-head" style="margin-top:10px"><span>${isSpecial ? '特码' : '三中三'}连错位置（理论分布）</span><span class="legend"><span>当前 ${missCur} 期</span></span></div>
    <div class="miss-run-bar" aria-label="连错分布">
      ${mark(q50, '中位'+q50)}
      ${mark(q95, '95%'+q95)}
      ${mark(missCur, '当前'+missCur)}
    </div>
    <div class="miss-run-legend"><span>0</span><span>最长 ${missMax} 期 · 中位 ${q50} · 95分位 ${q95}</span><span>${missScale}期</span></div>
    <p class="trend-note">时间轴与滚动率用于观察波动，不用于预测。当前${isSpecial?'特码':''}连错 ${missCur} 期${missCur >= q95 ? '，已超过理论95分位，但每期概率仍独立不变。' : missCur >= q50 ? '，高于中位数，仍在常见波动范围内。' : '，处于常见范围内。'}</p>`;
}

function renderQuickFilters() {
  const box = el('quickFilters');
  if (!box) return;
  const defs = historyView === 'special'
    ? [['all', '全部'], ['hit', '只看命中'], ['miss', '只看未中'], ['streak10', '连错≥10期']]
    : [['all', '全部'], ['hit', '只看有奖'], ['hit4', '命中≥4码'], ['spHit', '7码中特']];
  const examples = !String(query || '').trim()
    ? [['2026-320', '期号示例'], ['11-22', '日期示例'], ['07', '号码示例']]
    : [];
  const parts = defs.map(([k, t]) => `<button type="button" class="qf${quickFilter === k ? ' active' : ''}" data-qf="${k}">${esc(t)}</button>`);
  if (examples.length) {
    parts.push('<span class="pill subtle" style="margin:0 2px">试试</span>');
    parts.push(...examples.map(([v]) => `<button type="button" class="qf example" data-q="${esc(v)}" title="按${esc(v)}搜索">${esc(v)}</button>`));
  }
  box.innerHTML = parts.join('');
  box.querySelectorAll('[data-qf]').forEach(btn => btn.addEventListener('click', () => {
    quickFilter = btn.dataset.qf || 'all';
    const cb = el('onlyHit');
    if (quickFilter === 'hit') { onlyHit = true; if (cb) cb.checked = true; }
    else { onlyHit = false; if (cb) cb.checked = false; }
    historyLimit = HISTORY_PAGE; expanded = ''; renderHistory();
  }));
  box.querySelectorAll('[data-q]').forEach(btn => btn.addEventListener('click', () => {
    query = btn.dataset.q || '';
    const input = el('historySearch'); if (input) input.value = query;
    historyLimit = HISTORY_PAGE; expanded = ''; renderHistory();
  }));
}

function renderHistory() {
  if (!replay.length) return;
  const years = [...new Set(replay.map(r => String(r.year)))].sort().reverse();
  if (selectedScope !== 'recent' && selectedScope !== 'all' && !years.includes(selectedScope)) selectedScope = 'recent';
  // 「全部」是必须的：只有近 100 期时抽样噪声极大（命中率 95% 区间宽达 ±7pp），
  // 全样本才看得出这组号与随机没有差别。
  const scopes = ['recent', 'all', ...years];
  el('yearTabs').innerHTML = scopes.map(s => {
    const text = s === 'recent' ? `近${RECENT_WINDOW}期` : s === 'all' ? `全部${replay.length}期` : esc(s) + '年';
    return `<button type="button" class="tab${s === selectedScope ? ' active' : ''}" data-scope="${esc(s)}" aria-pressed="${s === selectedScope}">${text}</button>`;
  }).join('');
  el('yearTabs').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    selectedScope = btn.dataset.scope; expanded = ''; historyLimit = HISTORY_PAGE; renderHistory();
  }));
  el('viewTabs').querySelectorAll('.seg-btn').forEach(btn => {
    const active = btn.dataset.view === historyView;
    btn.className = 'seg-btn' + (active ? ' active' : '');
    btn.setAttribute('aria-pressed', String(active));
  });
  el('onlyHitLabel').textContent = historyView === 'special' ? '仅看命中特码' : '仅看有奖期';
  el('historyScopeTag').textContent = selectedScope === 'recent' ? `近${RECENT_WINDOW}期` : selectedScope === 'all' ? `全部${replay.length}期` : selectedScope + '年';
  el('historyNote').innerHTML = historyView === 'special'
    ? '每期主推为<b>同一组固定 7 码</b>，此处核对开奖<b>第 7 位特码</b>是否落在 7 码内。特码命中只做记录与命中率统计，<b>不折算金额</b>，也不并入三中三奖金；随机基线 7/49 ≈ 14.3%。<b>样本小时波动很大</b>：近 100 期的 95% 区间是 7.4%~21.1%，看结论请切到「全部」。这组号是模型读完整段历史后挑出来的，回放属<b>样本内核对</b>，不代表未来成绩。'
    : '每期主推为<b>同一组固定 7 码</b>，核对<b>前 6 位平码</b>：命中组数 = C(命中平码数, 3)。理论口径：随机 7 码命中 ≥3 个平码 3.10%/期（平均 32.3 期一次）；每期 35 组、每组 2 元、中奖组总返奖 700 倍（1,400 元，含本金）模拟，未计税费。<b>该赔率下每期期望 −¥16.81（返奖 76%）</b>，实测盈亏请先与期望对照再看。表中「7码中特」一列始终显示，切到本视图也不会丢失特码命中记录。';

  renderQuickFilters();
  const base = scopeRows();
  const rows = filteredRows(base);
  const shown = rows.slice().reverse().slice(0, historyLimit);
  const s3 = summarizeReplay(base), sp = summarizeSpecial(base);
  renderHistoryViz(base, s3, sp);
  const sb = searchBreakdown(base, query);
  el('filterCount').textContent = sb.label
    ? `筛出 ${rows.length} / ${base.length} 期${onlyHit ? '（已叠加「仅看命中」）' : ''} · ${sb.label}`
    : `${base.length} 期`;
  el('summary').innerHTML = historyView === 'special' ? specialMetricsHtml(sp, s3) : pick3MetricsHtml(s3, sp);
  el('historyHead').innerHTML = historyView === 'special'
    ? '<tr><th>期号 / 日期</th><th>开奖号码（末位特码）</th><th>主推 7 码</th><th>7码中特</th><th>连错期数</th></tr>'
    : '<tr><th>期号 / 日期</th><th>开奖号码（末位特码）</th><th>主推 7 码</th><th>命中平码</th><th>三中三组数</th><th>7码中特</th><th>模拟奖金</th></tr>';
  el('historyBody').innerHTML = shown.length
    ? shown.map((r, i) => historyRowHtml(r, i) + (expanded === r.label ? detailRowHtml(r) : '')).join('')
    : `<tr class="empty-row"><td colspan="${historyView === 'special' ? 5 : 7}">暂无符合条件的记录，请调整范围、搜索或「仅看命中」。</td></tr>`;
  // 加载到底：按钮隐藏并给出「已全部加载」，避免用户以为按钮失灵
  const historyDone = rows.length > 0 && rows.length <= historyLimit && historyLimit > HISTORY_PAGE;
  el('historyMore').hidden = rows.length <= historyLimit;
  el('historyAll').hidden = !historyDone;
  el('historyAll').textContent = historyDone ? `已显示全部 ${rows.length} 期` : '';
  el('historyBody').querySelectorAll('tr.row').forEach(tr => {
    const toggle = () => { const label = shown[Number(tr.dataset.idx)].label; expanded = expanded === label ? '' : label; renderHistory(); };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}
function specialBadge(r) {
  if (r.specialHit == null) return '<span class="badge">特码未记录</span>';
  return r.specialHit ? '<span class="badge win">✓ 7码中特</span>' : '<span class="badge lose">未中</span>';
}
function historyRowHtml(r, i) {
  const selected = new Set(r.hits);
  const head = `<td><span class="period">${esc(r.label)}<small>${esc(r.date)}</small></span><span class="caret">${expanded === r.label ? '▴' : '▾'}</span></td>`;
  const draw = `<td>${chipsHtml(r, selected)}</td>`;
  const plan = `<td><span class="nums center">${r.recommended.map(n => `<span class="num${selected.has(n) ? ' hit' : ''}${r.special === n ? ' special ' + wave(n) : ''}">${pad2(n)}</span>`).join('')}</span></td>`;
  if (historyView === 'special') {
    return `<tr class="row${r.specialHit ? ' row-hit' : ''}" data-idx="${i}" tabindex="0" aria-expanded="${expanded === r.label}">${head}${draw}${plan}<td>${specialBadge(r)}</td><td>${r.missRun == null ? '—' : `<span class="badge ${r.missRun === 0 ? 'win' : 'lose'}">${r.missRun} 期</span>`}</td></tr>`;
  }
  return `<tr class="row${r.triples > 0 ? ' row-hit' : ''}" data-idx="${i}" tabindex="0" aria-expanded="${expanded === r.label}">${head}${draw}${plan}<td>${r.hits.length} 码</td><td>${r.triples ? `<span class="badge win">${r.triples} 组</span>` : '<span class="badge lose">0 组</span>'}</td><td>${specialBadge(r)}</td><td class="money${r.prize ? ' win' : ''}">${money(r.prize)}</td></tr>`;
}
function detailRowHtml(r) {
  const groups = buildAll35Triples(r.recommended).filter(t => t.split('-').every(n => new Set(r.hits).has(Number(n))));
  const cols = historyView === 'special' ? 5 : 7;
  const planLine = `<div class="dg"><b>主推 7 码</b>${r.recommended.map(n => ballHtml(n, { size: 'xs', hit: r.hits.includes(n), special: r.special === n })).join('')}</div>`;
  const specialLine = `<div class="dg"><b>当期特码</b>${r.special == null ? '<span class="num unknown">--</span> 未记录' : ballHtml(r.special, { size: 'xs', special: true, hit: r.specialHit === true }) + ` ${pad2(r.special)}（${WAVE_LABEL[wave(r.special)]} · 生肖${zodiacOfNumber(r.special, r.date)}）`}${r.specialHit == null ? '' : ` · 7码中特：<b>${r.specialHit ? '命中' : '未中'}</b>`}</div>`;
  const pick3Line = `<div class="dg"><b>三中三</b>命中平码 ${r.hits.length} 码（${r.hits.length ? r.hits.map(pad2).join('、') : '无'}）· ${r.triples} 组 · 投入 ${money(r.cost)} · 模拟奖金 ${money(r.prize)} · 模拟盈亏 ${money(r.prize - r.cost)}</div>`;
  const groupsLine = `<div class="dg"><b>命中组合</b>${groups.length ? esc(groups.join('　')) : '无'}</div>`;
  const drawLine = `<div class="dg"><b>开奖</b>平码 ${r.numbers.map(pad2).join('、')} · ${specialLabel(r)}</div>`;
  return `<tr class="detail"><td colspan="${cols}">${drawLine}${planLine}${specialLine}${pick3Line}${groupsLine}</td></tr>`;
}
function specialMetricsHtml(sp, s3) {
  const rate = sp.rate.toFixed(1), baseline = sp.baseline.toFixed(1);
  const sig = significance(sp.wins, sp.periods, sp.baseline);
  const ci = sig ? `${sig.ci95[0].toFixed(1)}%~${sig.ci95[1].toFixed(1)}%` : '—';
  const verdictClass = !sig ? 'subtle' : sig.verdict === 'noise' ? 'subtle' : 'warn';
  const verdictText = sig
    ? (sig.verdict === 'noise'
      ? `与随机基线无显著差异（z=${sig.z.toFixed(2)}，n=${sp.periods}）`
      : `${sig.verdict === 'above' ? '高于' : '低于'}随机基线（z=${sig.z.toFixed(2)}，n=${sp.periods}）`)
    : '样本不足';
  // 连错的理论分布：号码固定、开奖独立，随机跟号本来就会有这么长的连错。
  const pSp = sp.baseline / 100;
  const missMedian = missRunQuantile(pSp, 0.5), missP95 = missRunQuantile(pSp, 0.05);
  return `<div class="metric hero">
    <div class="metric-head">7码中特 · 命中率<span class="pill subtle">随机基线 ${baseline}%</span></div>
    <div><span class="metric-val">${rate}%</span><span class="metric-label">${sp.wins} / ${sp.periods} 期命中（期望 ${sig ? sig.expected.toFixed(1) : '—'} 期）</span></div>
    <div class="metric-bar"><div class="metric-fill" style="width:${Math.min(100, sp.rate / (sp.baseline * 2) * 100)}%"></div></div>
    <div class="metric-sub"><b>${verdictText}</b><br>95% 置信区间 <b>${ci}</b>（基线 ${baseline}%）· 平均间隔 <b>${sp.interval == null ? '—' : sp.interval.toFixed(1) + ' 期'}</b>（理论 7.0 期）<br>近 ${sp.recentPeriods} 期命中 <b>${sp.recentWins}</b> 期${sp.unknown ? ` · 特码未记录 ${sp.unknown} 期不计入` : ''}</div>
  </div><div class="metric ${verdictClass}">
    <div class="metric-head">连错期数 · 对照理论分布</div>
    <div><span class="metric-val">${sp.currentMiss} 期</span><span class="metric-label">当前连错</span></div>
    <div class="metric-sub">最长连错 <b>${sp.maxMiss} 期</b><br>随机跟号的连错<b>中位数 ${missMedian} 期</b>、<b>95 分位 ${missP95} 期</b>——「已经很多期没中」不构成「快出了」，每期仍是 ${baseline}%。</div>
  </div><div class="metric gold">
    <div class="metric-head">同范围三中三（对照）</div>
    <div><span class="metric-val">${s3.winningRate.toFixed(1)}%</span><span class="metric-label">有奖期 ${s3.winningPeriods} / ${s3.periods}</span></div>
    <div class="metric-sub">累计命中 <b>${s3.groups} 组</b> · 模拟奖金 ${money(s3.prize)} / 投入 ${money(s3.cost)}（期望奖金 ${money(Math.round(s3.expectedPrize))}）<br>特码与三中三是同一份 7 码的两种口径，互不折算。</div>
  </div><div class="metric">
    <div class="metric-head">统计口径</div>
    <div class="calc-line"><span>判定</span><b>主推7码是否含当期特码</b></div>
    <div class="calc-line"><span>选号依据</span><b>固定 7 码（样本内）</b></div>
    <div class="calc-line"><span>金额</span><b>不模拟、不并入</b></div>
    <div class="metric-sub">这组号是模型读完整段历史后挑出来的，所以回放是<b>样本内核对</b>；未来每期的命中率在数学上就等于 ${baseline}%。</div>
  </div>`;
}
function pick3MetricsHtml(s3, sp) {
  const winRate = s3.winningRate.toFixed(1), returnRate = s3.returnRate.toFixed(1);
  const net = (s3.net >= 0 ? '+' : '') + s3.net;
  const sig = significance(s3.winningPeriods, s3.periods, s3.baselineWinningRate);
  const ci = sig ? `${sig.ci95[0].toFixed(2)}%~${sig.ci95[1].toFixed(2)}%` : '—';
  const verdictText = sig
    ? (sig.verdict === 'noise'
      ? `与随机理论无显著差异（z=${sig.z.toFixed(2)}，n=${s3.periods}）`
      : `${sig.verdict === 'above' ? '高于' : '低于'}随机理论（z=${sig.z.toFixed(2)}，n=${s3.periods}）`)
    : '样本不足';
  const p3 = s3.baselineWinningRate / 100;
  const missMedian = missRunQuantile(p3, 0.5), missP95 = missRunQuantile(p3, 0.05);
  // 期望奖金：固定 7 码与随机等价，所以这段区间的期望只由赔率口径决定，与号码好坏无关。
  const expPrize = Math.round(s3.expectedPrize);
  const devGroups = s3.groups - s3.periods * EXPECTED_GROUPS_PER_PERIOD;
  return `<div class="metric hero">
    <div class="metric-head">7码复式 · 有奖期占比<span class="pill subtle">随机理论 ${s3.baselineWinningRate.toFixed(2)}%</span></div>
    <div><span class="metric-val">${winRate}%</span><span class="metric-label">${s3.winningPeriods} / ${s3.periods} 期有奖</span></div>
    <div class="metric-bar"><div class="metric-fill" style="width:${Math.min(100, s3.winningRate)}%"></div></div>
    <div class="metric-sub"><b>${verdictText}</b> · 95% 区间 <b>${ci}</b><br>平均每期命中 <b>${s3.avgHits.toFixed(3)}</b> 个平码（随机基线 ${s3.baselineAvgHits.toFixed(3)}）<br>模拟奖金 <b>${money(s3.prize)}</b> / 投入 ${money(s3.cost)}（返奖比 ${returnRate}%）· <b>期望奖金 ${money(expPrize)}</b><br>模拟盈亏 ${money(net)} · 累计命中 <b>${s3.groups} 组</b>（期望 ${(s3.periods * EXPECTED_GROUPS_PER_PERIOD).toFixed(1)} 组，${devGroups >= 0 ? '多' : '少'} ${Math.abs(devGroups).toFixed(1)} 组）</div>
  </div><div class="metric warn">
    <div class="metric-head">这套赔率下的期望值</div>
    <div><span class="metric-val">${money2(s3.evPerPeriod)}</span><span class="metric-label">每期期望盈亏（${money(COST_PER_PERIOD)} 投入）</span></div>
    <div class="calc-line"><span>只算前6平码</span><b>返奖 ${THEORY_RETURN_RATE.toFixed(1)}%</b></div>
    <div class="calc-line"><span>若特码也算开奖号</span><b>返奖 ${ALT_RETURN_RATE.toFixed(1)}%（+${money2(ALT_EV_PER_PERIOD).slice(1)}/期）</b></div>
    <div class="calc-line"><span>打平所需倍数</span><b>${Math.round(FAIR_PAYOUT_MULTIPLIER)} 倍（现按 ${PAYOUT_MULTIPLIER} 倍）</b></div>
    <div class="metric-sub">同一份数据，只因「特码算不算开奖号」，每期期望就从 <b>${money2(s3.evPerPeriod)}</b> 翻成 <b>+${money2(ALT_EV_PER_PERIOD).slice(1)}</b>。请以你实际下注的销售方规则为准。</div>
  </div><div class="metric gold">
    <div class="metric-head">7码中特 · 常驻记录<span class="pill warn">切换视图不丢失</span></div>
    <div><span class="metric-val">${sp.rate.toFixed(1)}%</span><span class="metric-label">${sp.wins} / ${sp.periods} 期命中</span></div>
    <div class="metric-sub">当前连错 <b>${sp.currentMiss} 期</b> · 最长连错 ${sp.maxMiss} 期（随机中位 ${missRunQuantile(sp.baseline / 100, 0.5)} 期、95 分位 ${missRunQuantile(sp.baseline / 100, 0.05)} 期）<br>随机基线 ${sp.baseline.toFixed(1)}% · 特码命中只记录，不计入上面的模拟奖金。</div>
  </div><div class="metric">
    <div class="metric-head">回放核算说明</div>
    <div class="calc-line"><span>选号内核</span><b>固定 7 码（样本内）</b></div>
    <div class="calc-line"><span>每期投入</span><b>35 组 × 2 元 = 70 元</b></div>
    <div class="calc-line"><span>每组模拟奖金</span><b>2 元 × ${PAYOUT_MULTIPLIER} = ${money(PRIZE_PER_GROUP)}</b></div>
    <div class="calc-line"><span>命中组数</span><b>C(命中平码数, 3)</b></div>
    <div class="calc-line"><span>连错参考</span><b>中位 ${missMedian} 期 · 95 分位 ${missP95} 期</b></div>
    <div class="metric-sub">按 ${PAYOUT_MULTIPLIER} 倍为含本金的总返奖计算，未计税费；有奖不等于当期盈利。实际规则请以销售方为准。</div>
  </div>`;
}

/* ---------------- 跟号账本 ---------------- */
// 号码固定就意味着「长期押同一注」。用户真正想知道的是「我从哪天开始跟、跟到现在赚还是亏、
// 还差几组回本」，而不是一个滚动的近 100 期窗口。这张卡就是把这件事直接算给他看。
function renderLedger() {
  const body = el('ledgerBody');
  if (!body) return;
  const input = el('followSince');
  if (input && input.value !== followSince) input.value = followSince;
  const first = replay.length ? replay[0].date : '';
  const last = replay.length ? replay.at(-1).date : '';
  const tag = el('ledgerRangeTag');
  if (input) { input.min = first; input.max = last; }
  if (!followSince) {
    if (tag) tag.textContent = '未设置起点';
    body.innerHTML = `<p class="note">选一个开始跟号的日期，这里会按你的实际跟号区间累计投入、返奖与盈亏——比「近 100 期」更贴近你自己的账。数据覆盖 ${first} ~ ${last}。</p>`;
    return;
  }
  const led = followLedger(replay, followSince);
  if (!led || !led.active) {
    if (tag) tag.textContent = '起点超出范围';
    body.innerHTML = `<p class="note">该日期之后还没有开奖记录（数据覆盖 ${first} ~ ${last}），请改一个更早的日期。</p>`;
    return;
  }
  if (tag) tag.textContent = `${led.periods} 期 · ${led.since} 起`;
  const netText = `${led.net >= 0 ? '+' : ''}${money(led.net).replace('-', '-')}`;
  const expectedText = money(Math.round(led.expectedPrize));
  const gap = led.prize - led.expectedPrize;
  body.innerHTML = `
    <div class="ledger-grid">
      <div class="stat-cell accent"><div class="k">跟号区间</div><div class="v">${esc(led.firstLabel)} ~ ${esc(led.lastLabel)}</div><div class="s">${led.periods} 期 · 自 ${esc(led.since)}</div></div>
      <div class="stat-cell"><div class="k">累计投入</div><div class="v">${money(led.cost)}</div><div class="s">${led.periods} 期 × ${money(COST_PER_PERIOD)}</div></div>
      <div class="stat-cell"><div class="k">累计返奖</div><div class="v">${money(led.prize)}</div><div class="s">命中 ${led.groups} 组 · 有奖 ${led.winningPeriods} 期</div></div>
      <div class="stat-cell${led.net >= 0 ? ' win' : ''}"><div class="k">累计盈亏</div><div class="v">${netText}</div><div class="s">同期期望 ${expectedText}，${gap >= 0 ? '比期望多' : '比期望少'} ${money(Math.abs(Math.round(gap)))}</div></div>
    </div>
    <p class="note">${led.groupsToBreakEven > 0
      ? `距回本还差 <b>${led.groupsToBreakEven} 组</b>三中三（每组 ${money(PRIZE_PER_GROUP)}）。按每期 3.10% 的有奖率、每期期望命中 ${EXPECTED_GROUPS_PER_PERIOD.toFixed(4)} 组算，平均还要再跟 <b>${Math.round(led.groupsToBreakEven / EXPECTED_GROUPS_PER_PERIOD)}</b> 期——这个数字本身就说明了长期跟号的代价。`
      : `这段区间已经回本，累计比投入多 <b>${money(led.net)}</b>。注意这是抽样结果：同期期望返奖只有 ${expectedText}，跑赢期望属于运气，不代表下期还会赢。`}
      7 码中特 <b>${led.specialWins} / ${led.specialPeriods}</b> 期（基线 14.3%）。</p>`;
}

/* ---------------- 手动补录 ---------------- */
function manualCellHtml(i, label, special) {
  return `<div class="manual-cell${special ? ' special' : ''}">
    <label for="manualNum${i}">${esc(label)}</label>
    <input class="input" id="manualNum${i}" inputmode="numeric" maxlength="2" placeholder="--" autocomplete="off" aria-label="${esc(label)}">
  </div>`;
}
function renderManualInputs() {
  const cells = [];
  for (let i = 1; i <= 6; i++) cells.push(manualCellHtml(i, `正${i}`));
  cells.push('<span class="manual-plus" aria-hidden="true">+</span>');
  cells.push(manualCellHtml(7, '第7位特码', true));
  el('manualBalls').innerHTML = cells.join('');
  el('manualBalls').querySelectorAll('input').forEach(inp => {
    const advance = () => {
      const next = el('manualNum' + (Number(inp.id.replace('manualNum', '')) + 1));
      if (next) next.focus();
    };
    inp.addEventListener('input', () => {
      const v = String(inp.value || '').trim();
      clearTimeout(inp._advanceTimer);
      // 两位数直接跳格；一位数（想填 05 这类）等一会儿没继续输入也跳，
      // 否则手机上 7 个号码要点 14 次。
      if (v.length >= 2) { advance(); return; }
      if (v.length === 1) inp._advanceTimer = setTimeout(advance, SINGLE_DIGIT_ADVANCE_MS);
    });
    inp.addEventListener('blur', () => clearTimeout(inp._advanceTimer));
  });
}
function readManualSeven() {
  const out = [];
  for (let i = 1; i <= 7; i++) {
    const input = el('manualNum' + i);
    const v = String((input && input.value) || '').trim();
    out.push(v === '' ? NaN : Number(v));
  }
  return out;
}
function syncManualDate() {
  const p = parseLabel(el('manualLabel').value);
  const box = el('manualDate');
  if (!box) return;
  box.value = p ? periodToDate(p.year, p.periodNum) : '';
  box.placeholder = p ? '--' : '期号格式无效';
}
function resetManualInputs(keepLabel) {
  for (let i = 1; i <= 7; i++) { const input = el('manualNum' + i); if (input) { input.value = ''; clearTimeout(input._advanceTimer); } }
  const paste = el('manualPaste'); if (paste) paste.value = '';
  editingManual = null;
  const submit = el('manualSubmit');
  if (submit) submit.textContent = '💾 保存本期开奖';
  const label = el('manualLabel');
  if (label && !keepLabel) label.value = records.length ? nextLabelOf(records.at(-1).label) : '';
  syncManualDate();
}
function submitManual() {
  const replacing = !!editingManual;
  const result = validateManualDraw(el('manualLabel').value, readManualSeven(), records, { mode: replacing ? 'replace' : 'append' });
  if (result.error) { flash('bad', '❌ ' + result.error); return; }
  try {
    if (replacing) {
      const done = replaceLastManual(records, result.record);
      records = done.records;
    } else {
      records = appendManualDraw(records, result.record);
    }
  } catch (e) { flash('bad', '❌ 保存失败：' + (e.message || e)); return; }
  const warning = safePersist();
  const wasEditing = replacing;
  render();
  resetManualInputs();
  flash('ok', `${wasEditing ? '✏️ 已修改' : '✅ 已保存'} ${result.record.label}（${result.record.date}）：正码 ${result.record.numbers.map(pad2).join('、')} · 特码 ${pad2(result.record.special)}。仅存于当前浏览器。${warning}`);
  describeState(wasEditing ? '已修改手动补录期次。' : '已写入手动补录期次。');
}
// 把最后一条手动记录读回输入框，改完保存即覆盖——录错一个号不必整条撤销重来。
function editLastManual() {
  const manual = manualRecords(records);
  if (!manual.length) { flash('bad', '❌ 本机没有可修改的手动补录记录。'); return; }
  const last = manual.at(-1);
  if (records.at(-1).label !== last.label) {
    flash('bad', `❌ 手动记录 ${last.label} 之后已有新期次，改它会造成对不上账；请先撤销后面的期次。`);
    return;
  }
  editingManual = last.label;
  el('manualLabel').value = last.label;
  last.numbers.concat([last.special]).forEach((n, i) => { const input = el('manualNum' + (i + 1)); if (input) input.value = pad2(n); });
  syncManualDate();
  const btn = el('manualSubmit');
  if (btn) btn.textContent = '✏️ 保存修改';
  flash('ok', `✏️ 正在修改 ${last.label}（原特码 ${pad2(last.special)}）。改好后点「保存修改」，或点「清空输入」取消。`);
}
function undoManual() {
  const result = undoLastManual(records);
  if (result.error) { flash('bad', '❌ ' + result.error); return; }
  records = result.records;
  const warning = safePersist();
  render();
  resetManualInputs();
  flash('ok', `↩️ 已撤销手动记录 ${result.removed.label}（特码 ${pad2(result.removed.special)}）。${warning}`);
  describeState('已撤销最近一条手动补录。');
}
function onPasteInput(reportShort) {
  const box = el('manualPaste');
  const res = pickPastedSeven(box.value);
  if (res.error) {
    // 认出号码但不够 7 个时必须说出来。旧实现在这里直接 return，用户粘完什么都没发生，
    // 会以为输入框坏了。逐字输入时不弹，避免每敲一个字都报错。
    if (reportShort && res.found && res.found.length) flash('bad', '⚠️ ' + res.error);
    else if (!reportShort && !res.found) flash('bad', '⚠️ ' + res.error);
    return;
  }
  for (let i = 1; i <= 7; i++) { const input = el('manualNum' + i); if (input) input.value = pad2(res.seven[i - 1]); }
  box.value = '';
  const notes = [];
  if (res.dropped) notes.push(`已自动忽略 ${res.dropped} 个非开奖数字（${res.droppedHead}），它们多半来自期号或日期`);
  if (res.duplicate) notes.push(`⚠️ 其中 ${res.duplicate} 重复，保存前请改正`);
  flash(res.duplicate ? 'bad' : 'ok',
    `已按粘贴内容填入：正码 ${res.seven.slice(0, 6).map(pad2).join('、')} · 特码 ${pad2(res.seven[6])}。${notes.length ? notes.join('；') + '。' : ''}请核对后保存。`);
}

/* ---------------- 复制 / 同步 ---------------- */
async function copyRecommendation() {
  if (!recommendation || recommendation.numbers.length !== 7) return;
  const text = `三中三 ${recommendation.label}期 · 7码复式（35组）：${recommendation.numbers.map(pad2).join('、')}`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else { const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); const ok = document.execCommand('copy'); area.remove(); if (!ok) throw new Error('复制失败'); }
    el('copyBtn').textContent = '✅ 已复制';
    showToast('7码已复制到剪贴板', 'ok');
    setTimeout(() => { el('copyBtn').textContent = '📋 一键复制7码'; }, 1500);
  } catch (e) { status('复制失败，请手动抄录页面号码。'); showToast('复制失败，请手动抄录', 'bad'); }
}
function excludedNote() {
  return excluded.length ? `\n${excluded.length} 期前6码无效未参与统计：${excluded.slice(0, 8).join('、')}。` : '';
}
// 校验并写入上游数据：成功才落盘，失败保持原样并给出可读原因。
function applySource(payload, opts) {
  const o = opts || {};
  const before = records.length ? records.at(-1).label : '';
  const merged = mergeSource(records, payload);
  records = merged.records; excluded = merged.invalid; sourceUpdated = merged.updatedAt;
  const upstreamLabel = (parseLabel(payload && payload.latestId) || {}).label || records.at(-1).label;
  upstream = { label: upstreamLabel, updatedAt: (payload && payload.updatedAt) || merged.updatedAt || '' };
  const addedLabels = records.filter(r => r.label > before).map(r => r.label);
  const notes = [];
  if (merged.specialFilled) notes.push(`回填特码 ${merged.specialFilled} 期`);
  if (merged.confirmed) notes.push(`${merged.confirmed} 期手动记录已被数据源确认`);
  // 先记下这次同步结果，再落盘：刷新后状态条仍能显示「上次同步 新增 N 期 / 已是最新」。
  lastSync = { at: new Date().toISOString(), text: merged.added ? `新增 ${merged.added} 期` : '已是最新' };
  // 写盘失败不能抛出去：此时 records 已经换成新数据，异常冒到 sync() 的 catch 会变成
  // 「同步失败，未更改现有数据」——数据其实已经改了，而且 render() 也不会执行。
  const storeWarning = safePersist();
  render();
  setSyncHint('');
  const last = records.at(-1);
  const specialText = last.special == null ? '特码未记录' : '特码 ' + pad2(last.special);
  const prefix = o.viaCheck ? '（检查更新时上游直接返回了完整数据，已顺手完成同步）\n' : '';
  if (merged.skippedInvalid && merged.skippedInvalid.length) {
    notes.push(`上游 ${merged.skippedInvalid.join('、')} 号码无效已跳过，未影响后续期次`);
  }
  const tail = `${notes.length ? '\n' + notes.join('；') + '。' : ''}${excludedNote()}${storeWarning}`;
  if (merged.added) {
    status(withNote(`${prefix}✅ 同步完成：新增 ${merged.added} 期（${addedLabels.join('、')}）。本机最新 ${last.label}（${last.date}），${specialText}；上游更新于 ${fmtStamp(upstream.updatedAt)}。${tail}`));
    showToast(`同步完成，新增 ${merged.added} 期`, 'ok');
  } else {
    status(withNote(`${prefix}✅ 已是最新，没有新期次可加：本机与上游同为 ${last.label}（${last.date}），${specialText}。\n上游数据更新于 ${fmtStamp(upstream.updatedAt)}；上游一般每天开奖后更新一期（近期多在 UTC 22:00 前后，即新加坡时间次日 06:00 前后），等发布后再点即可。${tail}`));
    showToast('已是最新，没有新期次', 'ok');
  }
  renderSyncStrip();
  return merged;
}
function reportSyncFailure(e) {
  const msg = String((e && e.message) || e);
  lastSync = { at: new Date().toISOString(), text: '失败' };
  renderSyncStrip();
  persistMeta(); // 失败也记下来，刷新后仍能看到「上次同步 失败」
  // 按错误类型分流，不再靠正则匹配中文提示文案（文案一改分流就静默失效）。
  if (e && e.code === 'STALE_SOURCE') {
    const last = records.at(-1);
    status(withNote(`ℹ️ 无需同步：本机最新期 ${last.label} 已超前上游${upstream ? ' ' + upstream.label : ''}，未写入任何数据。\n若这是你手动补录的期次，等上游发布同一期后会自动核对；号码与官方不一致时会提示冲突，可用「撤销上条手动」回退。`));
    return;
  }
  // 网络问题和数据校验问题是两回事，提示不该混在一起：断网时提「撤销手动记录」只会让人更糊涂。
  const network = /Failed to fetch|NetworkError|Load failed|HTTP \d{3}/i.test(msg);
  status(withNote(network
    ? `❌ 同步失败（网络问题），未更改现有数据：${msg}。\n页面仍可正常使用内置快照（${builtinLabel || '--'}）。请检查网络后重试；急着核对可先用「开奖录入」手动补录本期。`
    : `❌ 同步失败，未更改现有数据：${msg}。\n请核对数据源与期号后重试；若提示与手动补录冲突，可先「撤销上条手动」或「修改上条手动」。`));
}
async function sync() {
  const btn = el('syncBtn'), check = el('checkBtn');
  btn.disabled = true; if (check) check.disabled = true;
  btn.textContent = '⏳ 正在同步…';
  status('正在下载上游完整开奖数据，请稍候…');
  try {
    const response = await fetch(SOURCE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    applySource(await response.json());
  } catch (e) { reportSyncFailure(e); }
  finally { btn.disabled = false; if (check) check.disabled = false; btn.textContent = '🔄 一键同步'; }
}
// 检查更新：只读上游文件开头，判断差几期，不写入数据。
async function checkUpdate(auto) {
  const btn = el('checkBtn'), syncBtn = el('syncBtn');
  if (btn) btn.disabled = true;
  if (syncBtn) syncBtn.disabled = true;
  if (!auto) status('正在检查上游最新期号（只读文件开头，不写入数据）…');
  try {
    const response = await fetch(SOURCE_URL, { cache: 'no-store', headers: { Range: SOURCE_PROBE_RANGE } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();
    if (response.status !== 206 && text.length > 4096) {
      // 上游忽略分段请求、直接给了完整文件：既然已经下载，就完成一次正式同步，不浪费流量。
      rangeProbeOk = false;
      applySource(JSON.parse(text), { viaCheck: true });
      return;
    }
    if (response.status === 206) { rangeProbeOk = true; persistMeta(); }
    const idMatch = /"latestId"\s*:\s*"(\d{4}-\d{3})"/.exec(text);
    const updatedMatch = /"updatedAt"\s*:\s*"([^"]+)"/.exec(text);
    if (!idMatch) throw new Error('未能从数据源读出最新期号');
    upstream = { label: (parseLabel(idMatch[1]) || {}).label || idMatch[1], updatedAt: updatedMatch ? updatedMatch[1] : '' };
    const local = records.at(-1).label;
    let message;
    if (upstream.label < local) {
      setSyncHint('');
      message = `ℹ️ 本机已超前上游：本机 ${local}，上游 ${upstream.label}（更新于 ${fmtStamp(upstream.updatedAt)}），无需同步。`;
    } else {
      const pending = countPeriodsBetween(local, upstream.label);
      if (pending === 0) {
        setSyncHint('');
        message = `✅ 已是最新：上游与本机同为 ${local}（上游更新于 ${fmtStamp(upstream.updatedAt)}），没有新期次可加。上游一般每天开奖后更新一期（近期多在 UTC 22:00 前后）。`;
      } else if (pending == null) {
        setSyncHint('');
        message = `🔔 上游最新 ${upstream.label}（更新于 ${fmtStamp(upstream.updatedAt)}），本机 ${local}；期号跨度无法直接推算，请点「一键同步」核对写入。`;
      } else {
        setSyncHint(`上游有 ${pending} 期可同步`);
        message = `🔔 上游已更新到 ${upstream.label}（${fmtStamp(upstream.updatedAt)}），本机停在 ${local}，差 ${pending} 期。点「一键同步」写入。`;
      }
    }
    renderSyncStrip();
    persistMeta();
    status(withNote(message));
  } catch (e) {
    if (!auto) status(withNote(`❌ 检查更新失败：${(e && e.message) || e}。可直接点「一键同步」，或检查网络后重试。`));
  } finally {
    if (btn) btn.disabled = false;
    if (syncBtn) syncBtn.disabled = false;
  }
}

/* ---------------- 导出 / 导入 ---------------- */
function exportLocalData() {
  if (!records.length) { showToast('暂无数据可导出', 'bad'); return; }
  const payload = storagePayload(records, sourceUpdated, excluded, { followSince });
  payload.lastSync = lastSync;
  payload.rangeOk = rangeProbeOk;
  payload.exportedAt = new Date().toISOString();
  payload.appBuild = APP_BUILD;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lottery-tool-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已导出本机数据备份', 'ok');
}
async function importLocalData(file) {
  if (!file) return;
  const text = await file.text();
  let saved;
  try { saved = JSON.parse(text); } catch (e) { showToast('导入失败：不是有效的 JSON 文件', 'bad'); status('❌ 导入失败：文件不是有效 JSON。'); return; }
  if (!saved || !Array.isArray(saved.draws)) { showToast('导入失败：备份格式不正确', 'bad'); status('❌ 导入失败：备份缺少 draws 数据。'); return; }
  try {
    const base = builtinRecords.length ? builtinRecords : records;
    const merged = mergeLocal(base, saved);
    records = merged.records;
    if (Array.isArray(saved.invalid) && saved.invalid.length) excluded = saved.invalid;
    if (saved.lastSync && typeof saved.lastSync === 'object') lastSync = saved.lastSync;
    if (saved.rangeOk === true) rangeProbeOk = true;
    followSince = /^\d{4}-\d{2}-\d{2}$/.test(saved.followSince || '') ? saved.followSince : followSince;
    const warning = safePersist();
    render();
    resetManualInputs();
    const notes = [`✅ 已导入备份：${file.name}`];
    if (merged.manualKept) notes.push(`恢复手动补录 ${merged.manualKept} 条`);
    if (merged.manualConfirmed) notes.push(`${merged.manualConfirmed} 条手动记录已被内置快照确认`);
    if (merged.specialFilled) notes.push(`回填特码 ${merged.specialFilled} 期`);
    if (merged.conflicts.length) notes.push('⚠️ ' + merged.conflicts.slice(0, 2).join('；'));
    if (warning) notes.push(warning.trim());
    status(withNote(notes.join('；') + '。'));
    showToast('备份导入成功', 'ok');
  } catch (e) {
    status('❌ 导入失败，未更改现有数据：' + (e.message || e));
    showToast('导入失败：' + (e.message || e), 'bad');
  }
}

/* ---------------- 初始化 ---------------- */
function switchView(view) {
  if (view === historyView) return;
  historyView = view; expanded = ''; historyLimit = HISTORY_PAGE; quickFilter = onlyHit ? 'hit' : 'all';
  const box = el('onlyHit'); if (box) box.checked = onlyHit;
  renderHistory();
}
function bindStaticEvents() {
  el('copyBtn').addEventListener('click', copyRecommendation);
  el('syncBtn').addEventListener('click', sync);
  // 旧缓存里的 index.html 可能还没有这个按钮，缺失时跳过绑定而不是整页报错。
  const checkBtn = el('checkBtn');
  if (checkBtn) checkBtn.addEventListener('click', () => checkUpdate(false));
  el('viewTabs').querySelectorAll('.seg-btn').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  el('historyMore').addEventListener('click', () => { historyLimit += HISTORY_PAGE; renderHistory(); });
  el('specialMore').addEventListener('click', () => { specialLimit += SPECIAL_PAGE; renderSpecialList(); });
  el('historySearch').addEventListener('input', e => { query = e.target.value || ''; historyLimit = HISTORY_PAGE; expanded = ''; renderHistory(); });
  el('onlyHit').addEventListener('change', e => { onlyHit = !!e.target.checked; quickFilter = onlyHit ? 'hit' : 'all'; historyLimit = HISTORY_PAGE; expanded = ''; renderHistory(); });
  el('manualSubmit').addEventListener('click', submitManual);
  el('manualUndo').addEventListener('click', undoManual);
  el('manualClear').addEventListener('click', () => { resetManualInputs(); flash('ok', '已清空输入框。'); });
  el('manualLabel').addEventListener('input', syncManualDate);
  // 逐字输入时只在凑够 7 个号码后自动填入；离开输入框还没凑够，才明确报错，
  // 免得每敲一个字符都弹一次提示。
  el('manualPaste').addEventListener('input', () => onPasteInput(false));
  el('manualPaste').addEventListener('change', () => onPasteInput(true));
  const editBtn = el('manualEdit');
  if (editBtn) editBtn.addEventListener('click', editLastManual);
  const since = el('followSince');
  if (since) since.addEventListener('change', () => {
    followSince = since.value || '';
    renderLedger();
    persistMeta();
  });
  const followClear = el('followClear');
  if (followClear) followClear.addEventListener('click', () => {
    followSince = '';
    renderLedger();
    persistMeta();
  });
  const ledgerQuick = el('ledgerQuick');
  if (ledgerQuick) ledgerQuick.querySelectorAll('[data-follow]').forEach(btn => btn.addEventListener('click', () => {
    const mode = btn.dataset.follow;
    let next = '';
    if (mode === 'today') next = todayUTC();
    else if (mode === 'all') next = (replay[0] && replay[0].date) || (records[0] && records[0].date) || '';
    else {
      const n = Number(mode);
      if (n > 0 && replay.length) next = (replay[Math.max(0, replay.length - n)] || replay[0]).date;
    }
    followSince = next;
    const input = el('followSince'); if (input) input.value = followSince;
    renderLedger();
    persistMeta();
  }));
  const exportBtn = el('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportLocalData);
  const importBtn = el('importBtn');
  const importFile = el('importFile');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => { const f = importFile.files && importFile.files[0]; importFile.value = ''; if (f) await importLocalData(f); });
  }
  if (typeof IntersectionObserver !== 'undefined' && document.querySelectorAll && document.querySelector) {
    try {
      const navLinks = Array.from(document.querySelectorAll('.anchor-nav a[href^="#"]'));
      const sections = navLinks.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
      if (sections.length) {
        const io = new IntersectionObserver(entries => {
          const visible = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
          if (!visible) return;
          navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + visible.target.id));
        }, { rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.2, 0.4] });
        sections.forEach(s => io.observe(s));
      }
    } catch (e) { /* 导航高亮不是关键功能 */ }
  }
}
async function init() {
  // 经用户确认，仅删除此浏览器本工具的旧快乐8数据，不清除其他站点数据。
  let cleanupWarning = '';
  try { for (const key of ['kl8_manual_draws_v1', 'kl8_recommended_budget_v1', 'kl8_pick_mode_v1']) localStorage.removeItem(key); } catch (e) { cleanupWarning = '\n无法删除旧快乐8浏览器数据，请检查浏览器存储权限。'; }
  el('buildTag').textContent = APP_BUILD;
  renderManualInputs();
  bindStaticEvents();
  try {
    const response = await fetch('./data/draws.json');
    if (!response.ok) throw new Error('内置数据读取失败 HTTP ' + response.status);
    const base = normalizeSource(await response.json());
    records = base.records; excluded = base.invalid; sourceUpdated = base.updatedAt;
    builtinRecords = base.records;
    builtinLabel = base.records.at(-1).label; builtinUpdated = base.updatedAt;
    let savedWarning = '', savedNotes = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        // 内置快照可能比本机备份新（站点更新过），也可能更旧（本机同步过），两种情况都要合并，
        // 不能因为「本机备份落后」就整体丢弃——否则手动补录与上次同步记录会被静默忽略、随后被覆盖。
        const merged = mergeLocal(records, saved);
        records = merged.records;
        excluded = Array.isArray(saved.invalid) && saved.invalid.length ? saved.invalid : base.invalid;
        // 期号口径仍以「官方更新时间」为准，不因本机备份里记的旧时间回退。
        sourceUpdated = base.updatedAt || saved.updatedAt || '';
        if (saved.lastSync && typeof saved.lastSync === 'object') lastSync = saved.lastSync;
        rangeProbeOk = saved.rangeOk === true;
        // 跟号账本起点：纯附加信息，格式不对就当没设过，不影响数据。
        followSince = /^\d{4}-\d{2}-\d{2}$/.test(saved.followSince || '') ? saved.followSince : '';
        if (merged.specialFilled) savedNotes.push(`本机备份补全了 ${merged.specialFilled} 期内置数据缺失的特码`);
        if (merged.manualKept) savedNotes.push(`本机手动补录 ${merged.manualKept} 条已恢复（最新 ${records.at(-1).label}）`);
        if (merged.manualConfirmed) savedNotes.push(`${merged.manualConfirmed} 条手动记录已被内置快照收录，按官方数据计`);
        if (merged.conflicts.length) {
          savedNotes.push('⚠️ ' + merged.conflicts.slice(0, 3).join('；') + (merged.conflicts.length > 3 ? ' 等' : '') + '。如需保留自己的记录，请先复制备份再继续同步');
        }
        if (merged.added) savedNotes.push(`内置快照之后本机还有 ${merged.added} 期`);
      }
    } catch (e) { savedWarning = '\n本机同步数据无效或有冲突，已使用内置数据：' + (e.message || e); }
    render();
    resetManualInputs();
    initNote = (savedWarning + (savedNotes.length ? '\n' + savedNotes.join('；') + '。' : '') + cleanupWarning).trim();
    describeState('');
    // 只有在确认上游支持分段请求后才自动检查，避免每次打开页面都下载完整数据。
    if (rangeProbeOk && /^https?:/.test(location.protocol)) checkUpdate(true);
  } catch (e) {
    el('syncBtn').disabled = true;
    status('初始化失败：' + (e.message || e) + '。请通过网站访问并检查网络。');
  }
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
init();
