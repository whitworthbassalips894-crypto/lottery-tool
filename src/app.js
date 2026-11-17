'use strict';
const SOURCE_URL = 'https://whitworthbassalips894-crypto.github.io/Number-selection-tool/data/draws.json';
const STORAGE_KEY = 'three_in_three_sync_v1';
let records = [], replay = [], selectedScope = 'recent', expanded = '';
let excluded = [], sourceUpdated = '', recommendation = null;
const el = id => document.getElementById(id);
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ball = (n, small = false) => `<span class="ball${small ? ' sm' : ''}" style="background:${WAVE_COLOR[WAVE_MAP[n]]}">${pad2(n)}</span>`;
function status(message){ el('syncStatus').textContent = message; }
function excludedText(){ return excluded.length ? `\n${excluded.length} 期前6码无效未参与统计：${excluded.slice(0,8).join('、')}。` : ''; }
function sourceObject(rows, updatedAt){ return { updatedAt, latestId: rows.at(-1).label, draws: rows.map(r => ({id:r.label, date:r.date, numbers:r.numbers})) }; }
function createRecommendation(rows){
  const label = nextLabelOf(rows.at(-1).label), p = parseLabel(label);
  return { label, numbers: run3in3At(rows, rows.length, p.year, p.periodNum, periodToDate(p.year,p.periodNum)).opt };
}
function render(){
  if (!records.length) return;
  const last = records.at(-1);
  el('totalCount').textContent = records.length;
  el('latestIssue').textContent = last.label;
  el('latestDate').textContent = last.date || '';
  el('latestBalls').innerHTML = last.numbers.map(n=>ball(n)).join('');
  recommendation = createRecommendation(records);
  el('targetIssue').textContent = recommendation.label;
  el('copyBtn').disabled = recommendation.numbers.length !== 7;
  el('recommendBalls').innerHTML = recommendation.numbers.length === 7 ? recommendation.numbers.map(n=>ball(n)).join('') : '<span class="desc">有效历史不足，暂无法生成完整7码，请同步更多数据。</span>';
  replay = buildReplay(records);
  renderHistory();
}
function renderHistory(){
  const years = [...new Set(replay.map(r=>String(r.year)))].sort().reverse();
  if (selectedScope !== 'recent' && !years.includes(selectedScope)) selectedScope = 'recent';
  const scopes = ['recent', ...years];
  el('yearTabs').innerHTML = scopes.map(s => `<button type="button" class="tab${s===selectedScope?' active':''}" data-scope="${esc(s)}" aria-pressed="${s===selectedScope}">${s==='recent'?'近100期':esc(s)+'年'}</button>`).join('');
  el('yearTabs').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { selectedScope=btn.dataset.scope; expanded=''; renderHistory(); }));
  const rows = selectedScope === 'recent' ? replay.slice(-100) : replay.filter(r=>String(r.year)===selectedScope);
  const wins = rows.filter(r=>r.triples>0).length, triples = rows.reduce((a,r)=>a+r.triples,0);
  el('summary').innerHTML = `<div class="stat">回放 <b>${rows.length}</b> 期</div><div class="stat">至少命中一组 <b>${wins}</b> 期</div><div class="stat">累计命中 <b>${triples}</b> 组</div>`;
  el('historyBody').innerHTML = rows.slice().reverse().map((r,i) => {
    const selected = new Set(r.hits);
    const line = `<tr data-idx="${i}" tabindex="0" aria-expanded="${expanded===r.label}"><td><b>${esc(r.label)}</b><br>${esc(r.date)}</td><td>${r.numbers.map(n=>`<span class="${selected.has(n)?'hit':''}">${pad2(n)}</span>`).join(' ')}</td><td>${r.recommended.map(n=>`<span class="${selected.has(n)?'hit':''}">${pad2(n)}</span>`).join(' ')}</td><td>${r.hits.length} 码</td><td>${r.triples} 组</td></tr>`;
    if (expanded !== r.label) return line;
    const groups = buildAll35Triples(r.recommended).filter(t => t.split('-').every(n=>selected.has(Number(n))));
    return line + `<tr class="detail"><td colspan="5">主推 ${r.recommended.map(pad2).join('、')}<br>命中号码：${r.hits.length?r.hits.map(pad2).join('、'):'无'}<br>命中组合：${groups.length?groups.join('　'):'无'}</td></tr>`;
  }).join('');
  const shown = rows.slice().reverse();
  el('historyBody').querySelectorAll('tr[data-idx]').forEach(tr => {
    const toggle = () => { const label=shown[Number(tr.dataset.idx)].label; expanded=expanded===label?'':label; renderHistory(); };
    tr.addEventListener('click',toggle);
    tr.addEventListener('keydown', e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}});
  });
}
async function copyRecommendation(){
  if (!recommendation || recommendation.numbers.length !== 7) return;
  const text = `三中三 ${recommendation.label}期 · 7码复式（35组）：${recommendation.numbers.map(pad2).join('、')}`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else { const area=document.createElement('textarea'); area.value=text; document.body.append(area); area.select(); const ok=document.execCommand('copy'); area.remove(); if(!ok) throw new Error('复制失败'); }
    el('copyBtn').textContent='✅ 已复制'; setTimeout(()=>{el('copyBtn').textContent='📋 一键复制7码';},1500);
  } catch(e) { status('复制失败，请手动抄录页面号码。'); }
}
async function sync(){
  const btn=el('syncBtn'); btn.disabled=true; status('正在读取数据源，请稍候…');
  try {
    const response=await fetch(SOURCE_URL,{cache:'no-store'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const merged=mergeSource(records,await response.json());
    // 写入成功后才替换内存，避免显示未保存的同步结果。
    localStorage.setItem(STORAGE_KEY,JSON.stringify({ ...sourceObject(merged.records,merged.updatedAt), invalid: merged.invalid }));
    records=merged.records; excluded=merged.invalid; sourceUpdated=merged.updatedAt;
    render();
    status(`同步完成：${merged.added ? '新增 '+merged.added+' 期' : '没有新增期次'}；数据源最新有效期 ${records.at(-1).label}。数据源可能延迟，请以官方开奖为准。${excludedText()}`);
  } catch(e) { status('同步失败，未更改现有数据：' + (e.message || e) + '。请检查网络、数据源或期号后重试。'); }
  finally { btn.disabled=false; }
}
async function init(){
  // 经用户确认，仅删除此浏览器本工具的旧快乐8数据，不清除其他站点数据。
  let cleanupWarning='';
  try { for(const key of ['kl8_manual_draws_v1','kl8_recommended_budget_v1','kl8_pick_mode_v1']) localStorage.removeItem(key); } catch(e) { cleanupWarning='\n无法删除旧快乐8浏览器数据，请检查浏览器存储权限。'; }
  el('copyBtn').addEventListener('click',copyRecommendation);
  el('syncBtn').addEventListener('click',sync);
  try {
    const response=await fetch('./data/draws.json');
    if(!response.ok) throw new Error('内置数据读取失败 HTTP '+response.status);
    const base=normalizeSource(await response.json()); records=base.records; excluded=base.invalid; sourceUpdated=base.updatedAt;
    let savedWarning='';
    try {
      const raw=localStorage.getItem(STORAGE_KEY);
      if(raw){ const saved=JSON.parse(raw); const merged=mergeSource(records,saved); records=merged.records; excluded=Array.isArray(saved.invalid) ? saved.invalid : base.invalid; sourceUpdated=merged.updatedAt; }
    } catch(e) { savedWarning='\n本机同步数据无效或有冲突，已使用内置数据：'+(e.message||e); }
    render();
    status(`当前最新有效期 ${records.at(-1).label}；内置或本机数据可能过期，请点击一键同步。${excludedText()}${savedWarning}${cleanupWarning}`);
  } catch(e) { el('syncBtn').disabled=true; status('初始化失败：'+(e.message||e)+'。请通过网站访问并检查网络。'); }
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
init();
