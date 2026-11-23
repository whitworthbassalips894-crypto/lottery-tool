'use strict';
const SOURCE_URL = 'https://whitworthbassalips894-crypto.github.io/Number-selection-tool/data/draws.json';
const STORAGE_KEY = 'three_in_three_sync_v1';
// 版本号与 sw.js 缓存名一起提升，避免旧缓存与新代码混用。
const APP_BUILD = '2026.11.23-r5';
const HISTORY_PAGE = 50, SPECIAL_PAGE = 30, RECENT_WINDOW = 100;
// 检查更新只取上游文件开头一小段，读出 latestId / updatedAt 即可判断差几期。
const SOURCE_PROBE_RANGE = 'bytes=0-1023';

let records = [], replay = [], excluded = [], sourceUpdated = '', recommendation = null;
let historyView = 'special', selectedScope = 'recent', expanded = '', query = '', onlyHit = false;
let historyLimit = HISTORY_PAGE, specialLimit = SPECIAL_PAGE;
let lastSync = null, upstream = null, rangeProbeOk = false, builtinLabel = '', builtinUpdated = '', initNote = '';

const el = id => document.getElementById(id);
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wave = n => (typeof WAVE_MAP !== 'undefined' && WAVE_MAP[n]) || 'blue';
const WAVE_LABEL = { red: '红波', blue: '蓝波', green: '绿波' };
const money = n => { const v = Number(n || 0); return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toLocaleString('en-US'); };

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
  const payload = storagePayload(records, sourceUpdated, excluded);
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
  // 冷门策略：主推 7 码就是近 COLD_WINDOW 期出现最少的一组，明细直接列出出现次数与遗漏
  return { label, numbers: plan.opt, picks: plan.picks, window: plan.window, history: plan.history };
}
function recommendDetailHtml(rec) {
  if (!rec.picks || rec.picks.length !== 7) return '';
  const worst = Math.max(...rec.picks.map(x => x.freq));
  return `<p class="note" style="margin:12px 0 0">选号口径（反命中 · 冷门）：取近 <b>${rec.window}</b> 期出现次数最少的 7 个平码；同频取遗漏更久者，再同则看近 <b>${rec.history}</b> 期。本组最多只出现过 <b>${worst}</b> 次，是被历史「看得最少」的号码组合，<b>目标是最低命中率</b>，不是提高中奖率。</p>
  <div class="composition">${rec.picks.map(x => `<span class="chip">${pad2(x.num)} · ${rec.window}期 <b>${x.freq}</b> 次 · 遗漏 <b>${x.omit}</b> 期</span>`).join('')}</div>`;
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
  return selectedScope === 'recent' ? replay.slice(-RECENT_WINDOW) : replay.filter(r => String(r.year) === selectedScope);
}
function filteredRows(base) {
  const q = query.trim();
  let rows = q ? base.filter(r => r.label.includes(q)) : base.slice();
  if (onlyHit) rows = rows.filter(r => (historyView === 'special' ? r.specialHit === true : r.triples > 0));
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
  renderStatStrip();
  renderRecommendation();
  renderHistory();
  renderSpecialList();
  renderManualState();
  renderSyncStrip();
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
}
function renderSpecialList() {
  const rows = records.slice().reverse();
  const shown = rows.slice(0, specialLimit);
  const hitLabels = new Set(replay.filter(r => r.specialHit).map(r => r.label));
  el('specialList').innerHTML = shown.map(r => {
    const hit = hitLabels.has(r.label);
    const ball = r.special == null ? '<span class="ball sm ghost">--</span>' : ballHtml(r.special, { size: 'sm' });
    const meta = r.special == null ? '未记录' : `${esc((r.date || '').slice(5))}<br>${esc(zodiacOfNumber(r.special, r.date))}${hit ? '<br><b>7码中特</b>' : ''}`;
    return `<div class="special-item${hit ? ' hit' : ''}" title="${esc(r.label)} 第7位特码${r.special == null ? '未记录' : ' ' + pad2(r.special)}${hit ? ' · 主推7码命中' : ''}">
      <span class="sp-period">${esc(r.label)}</span>${ball}<span class="sp-meta">${meta}</span></div>`;
  }).join('') || '<p class="note">暂无有效开奖数据。</p>';
  const withSpecial = records.filter(r => r.special != null).length;
  el('specialCount').textContent = `共 ${records.length} 期 · 已记录特码 ${withSpecial} 期 · 显示 ${shown.length} 期`;
  el('specialMore').hidden = specialLimit >= rows.length;
}
function renderManualState() {
  const manual = manualRecords(records);
  el('manualCount').textContent = `手动记录 ${manual.length} 条`;
  el('manualUndo').disabled = !manual.length;
  const labelInput = el('manualLabel');
  if (labelInput && !String(labelInput.value || '').trim()) {
    labelInput.value = records.length ? nextLabelOf(records.at(-1).label) : '';
  }
  syncManualDate();
}
function renderHistory() {
  if (!replay.length) return;
  const years = [...new Set(replay.map(r => String(r.year)))].sort().reverse();
  if (selectedScope !== 'recent' && !years.includes(selectedScope)) selectedScope = 'recent';
  const scopes = ['recent', ...years];
  el('yearTabs').innerHTML = scopes.map(s =>
    `<button type="button" class="tab${s === selectedScope ? ' active' : ''}" data-scope="${esc(s)}" aria-pressed="${s === selectedScope}">${s === 'recent' ? `近${RECENT_WINDOW}期` : esc(s) + '年'}</button>`).join('');
  el('yearTabs').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    selectedScope = btn.dataset.scope; expanded = ''; historyLimit = HISTORY_PAGE; renderHistory();
  }));
  el('viewTabs').querySelectorAll('.seg-btn').forEach(btn => {
    const active = btn.dataset.view === historyView;
    btn.className = 'seg-btn' + (active ? ' active' : '');
    btn.setAttribute('aria-pressed', String(active));
  });
  el('onlyHitLabel').textContent = historyView === 'special' ? '仅看命中特码' : '仅看有奖期';
  el('historyScopeTag').textContent = selectedScope === 'recent' ? `近${RECENT_WINDOW}期` : selectedScope + '年';
  el('historyNote').innerHTML = historyView === 'special'
    ? '按当期之前的有效历史逐期重现 <b>7 码主推</b>，核对开奖<b>第 7 位特码</b>是否落在 7 码内。特码命中只做记录与命中率统计，<b>不折算金额</b>，也不并入三中三奖金；随机基线 7/49 ≈ 14.3%。回放为事后模拟，不代表当时实际投注。'
    : '按当期之前的有效历史逐期重现 <b>7 码主推</b>（35 组三中三，选号内核为<b>反命中/冷门</b>策略），核对<b>前 6 位平码</b>：命中组数 = C(命中平码数, 3)。按每期 35 组、每组 2 元、中奖组总返奖 700 倍（1,400 元，含本金）模拟，未计税费。表中「7码中特」一列始终显示，切到本视图也不会丢失特码命中记录。';

  const base = scopeRows();
  const rows = filteredRows(base);
  const shown = rows.slice().reverse().slice(0, historyLimit);
  const s3 = summarizeReplay(base), sp = summarizeSpecial(base);
  el('filterCount').textContent = rows.length === base.length ? `${base.length} 期` : `筛出 ${rows.length} / ${base.length} 期`;
  el('summary').innerHTML = historyView === 'special' ? specialMetricsHtml(sp, s3) : pick3MetricsHtml(s3, sp);
  el('historyHead').innerHTML = historyView === 'special'
    ? '<tr><th>期号 / 日期</th><th>开奖号码（末位特码）</th><th>主推 7 码</th><th>7码中特</th><th>连错期数</th></tr>'
    : '<tr><th>期号 / 日期</th><th>开奖号码（末位特码）</th><th>主推 7 码</th><th>命中平码</th><th>三中三组数</th><th>7码中特</th><th>模拟奖金</th></tr>';
  el('historyBody').innerHTML = shown.length
    ? shown.map((r, i) => historyRowHtml(r, i) + (expanded === r.label ? detailRowHtml(r) : '')).join('')
    : `<tr class="empty-row"><td colspan="${historyView === 'special' ? 5 : 7}">暂无符合条件的记录，请调整范围、搜索或「仅看命中」。</td></tr>`;
  el('historyMore').hidden = rows.length <= historyLimit;
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
  const diff = (sp.rate - sp.baseline).toFixed(1);
  const diffText = sp.rate >= sp.baseline ? `高于随机基线 ${diff}pp` : `低于随机基线 ${Math.abs(Number(diff)).toFixed(1)}pp`;
  return `<div class="metric hero">
    <div class="metric-head">7码中特 · 命中率<span class="pill subtle">随机基线 ${baseline}%</span></div>
    <div><span class="metric-val">${rate}%</span><span class="metric-label">${sp.wins} / ${sp.periods} 期命中</span></div>
    <div class="metric-bar"><div class="metric-fill" style="width:${Math.min(100, sp.rate / (sp.baseline * 2) * 100)}%"></div></div>
    <div class="metric-sub">${diffText}；平均间隔 <b>${sp.interval == null ? '—' : sp.interval.toFixed(1) + ' 期'}</b> · 当前连错 <b>${sp.currentMiss} 期</b> · 最长连错 ${sp.maxMiss} 期<br>近 ${sp.recentPeriods} 期命中 <b>${sp.recentWins}</b> 期${sp.unknown ? ` · 特码未记录 ${sp.unknown} 期不计入` : ''}</div>
  </div><div class="metric gold">
    <div class="metric-head">同范围三中三（对照）</div>
    <div><span class="metric-val">${s3.winningRate.toFixed(1)}%</span><span class="metric-label">有奖期 ${s3.winningPeriods} / ${s3.periods}</span></div>
    <div class="metric-sub">累计命中 <b>${s3.groups} 组</b> · 模拟奖金 ${money(s3.prize)} / 投入 ${money(s3.cost)}<br>特码与三中三是同一份 7 码的两种口径，互不折算。</div>
  </div><div class="metric">
    <div class="metric-head">统计口径</div>
    <div class="calc-line"><span>判定</span><b>主推7码是否含当期特码</b></div>
    <div class="calc-line"><span>选号依据</span><b>仅前6位平码 · 冷门 7 码</b></div>
    <div class="calc-line"><span>金额</span><b>不模拟、不并入</b></div>
    <div class="metric-sub">特码不进入评分，因此加入特码统计不会改变任何一期的 7 码方案。</div>
  </div>`;
}
function pick3MetricsHtml(s3, sp) {
  const winRate = s3.winningRate.toFixed(1), returnRate = s3.returnRate.toFixed(1);
  const net = (s3.net >= 0 ? '+' : '') + s3.net;
  return `<div class="metric hero">
    <div class="metric-head">7码复式 · 有奖期占比</div>
    <div><span class="metric-val">${winRate}%</span><span class="metric-label">${s3.winningPeriods} / ${s3.periods} 期有奖</span></div>
    <div class="metric-bar"><div class="metric-fill" style="width:${Math.min(100, s3.winningRate)}%"></div></div>
    <div class="metric-sub">平均每期命中 <b>${s3.avgHits.toFixed(3)}</b> 个平码（随机基线 ${s3.baselineAvgHits.toFixed(3)}），有奖率对照随机 ${s3.baselineWinningRate.toFixed(2)}%<br>模拟奖金 <b>${money(s3.prize)}</b> / 投入 ${money(s3.cost)}（返奖比 ${returnRate}%）<br>模拟盈亏 ${money(net)} · 累计命中 <b>${s3.groups} 组</b></div>
  </div><div class="metric gold">
    <div class="metric-head">7码中特 · 常驻记录<span class="pill warn">切换视图不丢失</span></div>
    <div><span class="metric-val">${sp.rate.toFixed(1)}%</span><span class="metric-label">${sp.wins} / ${sp.periods} 期命中</span></div>
    <div class="metric-sub">当前连错 <b>${sp.currentMiss} 期</b> · 平均间隔 ${sp.interval == null ? '—' : sp.interval.toFixed(1) + ' 期'} · 随机基线 ${sp.baseline.toFixed(1)}%<br>特码命中只记录，不计入上面的模拟奖金。</div>
  </div><div class="metric">
    <div class="metric-head">回放核算说明</div>
    <div class="calc-line"><span>选号内核</span><b>反命中 · 冷门 7 码</b></div>
    <div class="calc-line"><span>每期投入</span><b>35 组 × 2 元 = 70 元</b></div>
    <div class="calc-line"><span>每组模拟奖金</span><b>2 元 × 700 = 1,400 元</b></div>
    <div class="calc-line"><span>命中组数</span><b>C(命中平码数, 3)</b></div>
    <div class="metric-sub">按 700 倍为含本金的总返奖计算，未计税费；有奖不等于当期盈利。实际规则请以销售方为准。</div>
  </div>`;
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
    inp.addEventListener('input', () => {
      if (String(inp.value || '').trim().length >= 2) {
        const next = el('manualNum' + (Number(inp.id.replace('manualNum', '')) + 1));
        if (next) next.focus();
      }
    });
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
  for (let i = 1; i <= 7; i++) { const input = el('manualNum' + i); if (input) input.value = ''; }
  const paste = el('manualPaste'); if (paste) paste.value = '';
  const label = el('manualLabel');
  if (label && !keepLabel) label.value = records.length ? nextLabelOf(records.at(-1).label) : '';
  syncManualDate();
}
function submitManual() {
  const result = validateManualDraw(el('manualLabel').value, readManualSeven(), records);
  if (result.error) { flash('bad', '❌ ' + result.error); return; }
  try {
    records = appendManualDraw(records, result.record);
  } catch (e) { flash('bad', '❌ 保存失败：' + (e.message || e)); return; }
  const warning = safePersist();
  render();
  resetManualInputs();
  flash('ok', `✅ 已保存 ${result.record.label}（${result.record.date}）：正码 ${result.record.numbers.map(pad2).join('、')} · 特码 ${pad2(result.record.special)}。仅存于当前浏览器。${warning}`);
  describeState('已写入手动补录期次。');
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
function onPasteInput() {
  const box = el('manualPaste');
  const nums = parsePastedNumbers(box.value);
  if (nums.length < 7) return;
  for (let i = 1; i <= 7; i++) { const input = el('manualNum' + i); if (input) input.value = pad2(nums[i - 1]); }
  box.value = '';
  flash('ok', `已按粘贴内容填入：正码 ${nums.slice(0, 6).map(pad2).join('、')} · 特码 ${pad2(nums[6])}。请核对后保存。`);
}

/* ---------------- 复制 / 同步 ---------------- */
async function copyRecommendation() {
  if (!recommendation || recommendation.numbers.length !== 7) return;
  const text = `三中三 ${recommendation.label}期 · 7码复式（35组）：${recommendation.numbers.map(pad2).join('、')}`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else { const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); const ok = document.execCommand('copy'); area.remove(); if (!ok) throw new Error('复制失败'); }
    el('copyBtn').textContent = '✅ 已复制'; setTimeout(() => { el('copyBtn').textContent = '📋 一键复制7码'; }, 1500);
  } catch (e) { status('复制失败，请手动抄录页面号码。'); }
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
  persist();
  render();
  setSyncHint('');
  const last = records.at(-1);
  const specialText = last.special == null ? '特码未记录' : '特码 ' + pad2(last.special);
  const prefix = o.viaCheck ? '（检查更新时上游直接返回了完整数据，已顺手完成同步）\n' : '';
  const tail = `${notes.length ? '\n' + notes.join('；') + '。' : ''}${excludedNote()}`;
  if (merged.added) {
    status(withNote(`${prefix}✅ 同步完成：新增 ${merged.added} 期（${addedLabels.join('、')}）。本机最新 ${last.label}（${last.date}），${specialText}；上游更新于 ${fmtStamp(upstream.updatedAt)}。${tail}`));
  } else {
    status(withNote(`${prefix}✅ 已是最新，没有新期次可加：本机与上游同为 ${last.label}（${last.date}），${specialText}。\n上游数据更新于 ${fmtStamp(upstream.updatedAt)}；上游一般每天开奖后更新一期（近期多在 UTC 22:00 前后，即新加坡时间次日 06:00 前后），等发布后再点即可。${tail}`));
  }
  renderSyncStrip();
  return merged;
}
function reportSyncFailure(e) {
  const msg = String((e && e.message) || e);
  lastSync = { at: new Date().toISOString(), text: '失败' };
  renderSyncStrip();
  persistMeta(); // 失败也记下来，刷新后仍能看到「上次同步 失败」
  if (/落后于当前记录/.test(msg)) {
    const last = records.at(-1);
    status(withNote(`ℹ️ 无需同步：本机最新期 ${last.label} 已超前上游${upstream ? ' ' + upstream.label : ''}，未写入任何数据。\n若这是你手动补录的期次，等上游发布同一期后会自动核对；号码与官方不一致时会提示冲突，可用「撤销上条手动」回退。`));
    return;
  }
  status(withNote(`❌ 同步失败，未更改现有数据：${msg}。\n请检查网络、数据源或期号后重试；若提示与手动补录冲突，可先撤销该条手动记录。`));
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

/* ---------------- 初始化 ---------------- */
function switchView(view) {
  if (view === historyView) return;
  historyView = view; expanded = ''; historyLimit = HISTORY_PAGE;
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
  el('onlyHit').addEventListener('change', e => { onlyHit = !!e.target.checked; historyLimit = HISTORY_PAGE; expanded = ''; renderHistory(); });
  el('manualSubmit').addEventListener('click', submitManual);
  el('manualUndo').addEventListener('click', undoManual);
  el('manualClear').addEventListener('click', () => { resetManualInputs(); flash('ok', '已清空输入框。'); });
  el('manualLabel').addEventListener('input', syncManualDate);
  el('manualPaste').addEventListener('input', onPasteInput);
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
    builtinLabel = base.records.at(-1).label; builtinUpdated = base.updatedAt;
    let savedWarning = '';
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const merged = mergeSource(records, saved);
        records = merged.records;
        excluded = Array.isArray(saved.invalid) && saved.invalid.length ? saved.invalid : base.invalid;
        sourceUpdated = merged.updatedAt || base.updatedAt;
        if (saved.lastSync && typeof saved.lastSync === 'object') lastSync = saved.lastSync;
        rangeProbeOk = saved.rangeOk === true;
      }
    } catch (e) { savedWarning = '\n本机同步数据无效或有冲突，已使用内置数据：' + (e.message || e); }
    render();
    resetManualInputs();
    initNote = (savedWarning + cleanupWarning).trim();
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
