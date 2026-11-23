'use strict';
// 端到端 DOM 测试：用 jsdom 真实解析 index.html 并执行三个脚本，模拟点击、输入与同步。
// 未安装 jsdom 时整组跳过（npm install 后再跑），不影响 node --test 的其余用例。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { JSDOM = null; }
const skip = JSDOM ? false : '未安装 jsdom，跳过端到端 DOM 测试（npm install 后重跑）';

const ROOT = path.join(__dirname, '..');
const FILES = ['src/engine.js', 'src/data.js', 'src/app.js'];
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/draws.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const NEXT = { id: '2026-327', year: 2026, period: '327', periodNum: 327, date: '2026-11-23', numbers: [3, 11, 22, 35, 41, 48], special: 7 };
const remoteWithNext = { ...snapshot, updatedAt: '2026-11-23T22:00:00.000Z', latestId: '2026-327', draws: [NEXT, ...snapshot.draws] };

function pageHtml() {
  let html = indexHtml;
  for (const f of FILES) {
    const tag = `<script src="./${f}"></script>`;
    assert.ok(html.includes(tag), 'index.html 缺少脚本引用 ' + f);
    html = html.replace(tag, '<script>\n' + fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n</script>');
  }
  return html;
}
const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

// opts.probe = { status, text }：模拟带 Range 头的「检查更新」响应（206 = 支持分段请求，
// 200 + 完整文本 = 上游忽略 Range）；opts.netError = '...' 模拟网络失败。
async function boot(remote, storage, builtin, opts) {
  const o = opts || {};
  const local = builtin || snapshot;
  const errors = [], copied = [], requests = [];
  const dom = new JSDOM(pageHtml(), {
    runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url, init) => {
        const ranged = !!(init && init.headers && init.headers.Range);
        requests.push({ url: String(url), ranged, range: ranged ? init.headers.Range : null, cache: init && init.cache });
        if (o.netError && String(url).startsWith('http')) throw new Error(o.netError); // 只断上游，不影响内置快照
        if (ranged && o.probe) return { ok: true, status: o.probe.status, text: async () => o.probe.text };
        return { ok: true, status: 200, json: async () => (String(url).startsWith('http') ? remote : local) };
      };
      window.addEventListener('error', e => errors.push(String((e.error && e.error.stack) || e.message)));
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async t => copied.push(t) }, configurable: true });
      for (const [k, v] of Object.entries(storage || {})) window.localStorage.setItem(k, v);
    }
  });
  await wait(420);
  const window = dom.window, document = window.document;
  const api = {
    dom, window, document, errors, copied, requests,
    cellTexts: id => Array.from(document.querySelectorAll(`#${id} .stat-cell`)).map(c => ({
      cls: c.className, k: c.querySelector('.k').textContent, v: c.querySelector('.v').textContent,
      s: c.querySelector('.s') ? c.querySelector('.s').textContent : null
    })),
    $: id => document.getElementById(id),
    q: sel => document.querySelector(sel),
    $$: sel => Array.from(document.querySelectorAll(sel)),
    text: id => (document.getElementById(id) ? document.getElementById(id).textContent : null),
    html: id => (document.getElementById(id) ? document.getElementById(id).innerHTML : null),
    click: (sel, ms = 140) => {
      const node = typeof sel === 'string' ? document.querySelector(sel) : sel;
      assert.ok(node, '找不到可点击元素：' + sel);
      node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return wait(ms);
    },
    // 等待异步渲染/同步完成，不用固定 sleep 猜时间。
    // 注意：断言不要直接 diff 整个 storage()（1787 期），失败时 util.inspect 会把进程卡死。
    until: async (fn, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (fn()) return; await wait(40); }
      assert.ok(fn(), '等待条件超时（' + ms + 'ms）：' + String(fn).slice(0, 120));
    },
    type: (id, value) => {
      const node = document.getElementById(id);
      node.value = value;
      node.dispatchEvent(new window.Event('input', { bubbles: true }));
      return wait(120);
    },
    check: (id, checked) => {
      const node = document.getElementById(id);
      node.checked = checked;
      node.dispatchEvent(new window.Event('change', { bubbles: true }));
      return wait(140);
    },
    storage: () => JSON.parse(window.localStorage.getItem('three_in_three_sync_v1') || 'null'),
    flat: id => (document.getElementById(id) ? document.getElementById(id).textContent.replace(/\s+/g, ' ').trim() : null),
    get: name => window.eval(name)
  };
  assert.deepEqual(errors, [], '页面脚本执行报错');
  return api;
}

test('页面结构：蓝白主题、移动端适配与无障碍关联齐全', { skip }, () => {
  assert.match(indexHtml, /<meta name="viewport" content="width=device-width, initial-scale=1/);
  assert.match(indexHtml, /<meta name="theme-color" content="#1d4ed8">/);
  assert.match(indexHtml, /lang="zh-CN"/);
  // 蓝白配色变量
  for (const token of ['--paper:#eef3fb', '--card:#fff', '--brand:#1d4ed8', '--brand-deep:#1e3a8a', '--ink:#152438']) {
    assert.ok(indexHtml.includes(token), '缺少配色变量 ' + token);
  }
  // 移动端断点与关键响应式规则
  assert.match(indexHtml, /@media \(max-width:640px\)/);
  assert.match(indexHtml, /@media \(max-width:900px\)/);
  const mobile = indexHtml.split('@media (max-width:640px)')[1];
  for (const rule of ['.table-wrap', 'table.hist', '.special-grid', '.manual-grid', '.stat-strip', '.metrics', '.ball', '.card']) {
    assert.ok(mobile.includes(rule), '640px 断点未覆盖 ' + rule);
  }
  assert.match(indexHtml, /\.table-wrap\{overflow-x:auto/);
  assert.match(indexHtml, /\.scroll-hint\{display:none/);
  assert.ok(mobile.includes('.scroll-hint{display:block}'), '移动端应提示表格可横向滑动');
  // 锚点导航的每个目标都存在
  const anchors = [...indexHtml.matchAll(/<a href="#([\w-]+)">/g)].map(m => m[1]);
  assert.ok(anchors.length >= 6, '锚点导航过少');
  for (const id of anchors) assert.match(indexHtml, new RegExp(`id="${id}"`), '导航目标缺失 #' + id);
  // aria-labelledby / label for 都能对应到真实元素
  const doc = new JSDOM(indexHtml).window.document;
  for (const node of Array.from(doc.querySelectorAll('[aria-labelledby]'))) {
    assert.ok(doc.getElementById(node.getAttribute('aria-labelledby')), 'aria-labelledby 目标缺失：' + node.id);
  }
  for (const label of Array.from(doc.querySelectorAll('label[for]'))) {
    assert.ok(doc.getElementById(label.getAttribute('for')), 'label for 目标缺失：' + label.getAttribute('for'));
  }
  for (const table of Array.from(doc.querySelectorAll('table'))) assert.ok(table.querySelector('thead'), '表格缺少 thead');
});

test('首屏渲染：开奖栏含第7位特码、指标条、推荐、特码记录与历史命中', { skip }, async () => {
  const p = await boot(snapshot);
  assert.equal(p.text('totalCount'), '1786');
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.text('latestDate'), '2026-11-22');
  assert.match(p.text('latestMeta'), /第 7 位特码 23/);
  const wraps = p.$$('#latestBalls .ball-wrap');
  assert.equal(wraps.length, 7, '最新开奖应有 7 个带标签的号码球');
  assert.deepEqual(wraps.slice(0, 6).map(w => w.querySelector('.ball-label').textContent), ['正1', '正2', '正3', '正4', '正5', '正6']);
  const lastWrap = wraps[6];
  assert.equal(lastWrap.querySelector('.ball-label').textContent, '特码');
  assert.equal(lastWrap.querySelector('.ball-label').className, 'ball-label special');
  assert.equal(lastWrap.querySelector('.ball').textContent, '23');
  assert.ok(lastWrap.querySelector('.ball').classList.contains('is-special'));
  assert.ok(p.q('#latestBalls .ball-plus'), '平码与特码之间应有分隔符');
  assert.equal(p.$$('#statStrip .stat-cell').length, 5);
  assert.match(p.$('statStrip').textContent, /近100期7码中特/);
  assert.equal(p.text('targetIssue'), '2026-327');
  assert.equal(p.$$('#recommendBalls .ball').length, 7);
  assert.equal(p.$$('#recommendComposition .chip').length, 4);
  assert.match(p.text('recommendPicks'), /固定 7 码/);
  assert.equal(p.$$('#recommendPicks .chip').length, 7);
  assert.match(p.$('recommendPicks').textContent, /号码固定/);
  // 固定号码：与引擎常量一致，且与历史数据无关
  assert.deepEqual(Array.from(p.get('recommendation').numbers), Array.from(p.get('FIXED_SEVEN')));
  assert.equal(p.$$('#specialList .special-item').length, 30);
  assert.match(p.text('specialCount'), /共 1786 期 · 已记录特码 1786 期 · 显示 30 期/);
  assert.equal(p.$$('#historyBody tr.row').length, 50);
  assert.equal(p.$$('#historyHead th').length, 5);
  assert.match(p.text('syncStatus'), /特码 23/);
  assert.equal(p.$('manualLabel').value, '2026-327');
  assert.equal(p.$('manualDate').value, '2026-11-23');
  assert.equal(p.$$('#manualBalls input').length, 7);
  assert.equal(p.q('#manualBalls .manual-cell.special label').textContent, '第7位特码');
  assert.equal(p.$('manualUndo').disabled, true);
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('历史命中：特码与三中三分别展示，7码中特在两个视图都常驻', { skip }, async () => {
  const p = await boot(snapshot);
  const heads = () => p.$$('#historyHead th').map(th => th.textContent);
  // 默认特码视图
  assert.deepEqual(heads(), ['期号 / 日期', '开奖号码（末位特码）', '主推 7 码', '7码中特', '连错期数']);
  assert.equal(p.q('#viewTabs .seg-btn.active').dataset.view, 'special');
  assert.equal(p.text('onlyHitLabel'), '仅看命中特码');
  const specialSummary = p.text('summary');
  assert.match(specialSummary, /7码中特 · 命中率/);
  assert.match(specialSummary, /随机基线 14\.3%/);
  assert.match(specialSummary, /不模拟、不并入/);
  assert.ok(p.$$('#historyBody .badge.win').length >= 1);
  // 点击切换到三中三视图
  await p.click('#viewTabs .seg-btn[data-view="pick3"]');
  assert.deepEqual(heads(), ['期号 / 日期', '开奖号码（末位特码）', '主推 7 码', '命中平码', '三中三组数', '7码中特', '模拟奖金']);
  assert.equal(p.q('#viewTabs .seg-btn.active').dataset.view, 'pick3');
  assert.equal(p.text('onlyHitLabel'), '仅看有奖期');
  const pick3Summary = p.text('summary');
  assert.match(pick3Summary, /有奖期占比/);
  assert.match(pick3Summary, /35 组 × 2 元 = 70 元/);
  assert.match(pick3Summary, /2 元 × 700 = 1,400 元/);
  // 关键要求：切到三中三视图后，7码中特记录仍然可见（指标卡 + 每行一列）
  assert.match(pick3Summary, /7码中特 · 常驻记录/);
  assert.match(pick3Summary, /切换视图不丢失/);
  const colIndex = heads().indexOf('7码中特');
  const rows = p.$$('#historyBody tr.row');
  assert.equal(rows.length, 50);
  const badges = rows.map(tr => tr.children[colIndex].textContent.trim());
  assert.ok(badges.every(b => b === '✓ 7码中特' || b === '未中' || b === '特码未记录'));
  assert.ok(badges.filter(b => b === '✓ 7码中特').length >= 1, '三中三视图必须继续显示特码命中');
  // 切回特码视图，命中记录条数一致（切换不丢数据）
  await p.click('#viewTabs .seg-btn[data-view="special"]');
  assert.equal(p.$$('#historyBody tr.row').length, 50);
  assert.ok(p.$$('#historyBody .badge.win').length >= 1);
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('历史命中交互：展开明细、年份范围、搜索、仅看命中、加载更多', { skip }, async () => {
  const p = await boot(snapshot);
  // 展开 / 收起明细
  const firstRow = p.$$('#historyBody tr.row')[0];
  const label = firstRow.querySelector('.period').textContent.trim();
  await p.click(firstRow);
  let detail = p.q('#historyBody tr.detail');
  assert.ok(detail, '点击后应展开明细');
  assert.equal(detail.querySelector('td').colSpan, 5);
  assert.match(detail.textContent, /当期特码/);
  assert.match(detail.textContent, /三中三/);
  assert.match(detail.textContent, /命中组合/);
  assert.equal(p.$$('#historyBody tr.row')[0].getAttribute('aria-expanded'), 'true');
  await p.click(p.$$('#historyBody tr.row')[0]);
  assert.ok(!p.q('#historyBody tr.detail'), '再次点击应收起明细');
  // 年份范围切换
  await p.click(p.$$('#yearTabs .tab')[2]);
  assert.equal(p.text('historyScopeTag'), '2025年');
  assert.match(p.text('filterCount'), /365 期/);
  assert.ok(p.$$('#yearTabs .tab')[2].classList.contains('active'));
  // 搜索期号
  await p.type('historySearch', '2025-100');
  assert.equal(p.$$('#historyBody tr.row').length, 1);
  assert.match(p.text('filterCount'), /筛出 1 \/ 365 期/);
  await p.type('historySearch', '');
  // 仅看命中（特码视图 → 只看7码中特）
  await p.check('onlyHit', true);
  const rows = p.$$('#historyBody tr.row');
  assert.ok(rows.length >= 1 && rows.length < 365);
  assert.ok(rows.every(tr => tr.textContent.includes('✓ 7码中特')), '仅看命中不应出现未中记录');
  assert.ok(p.$$('#historyBody tr.row').every(tr => tr.classList.contains('row-hit')));
  await p.check('onlyHit', false);
  // 三中三视图下「仅看命中」= 有奖期
  await p.click('#viewTabs .seg-btn[data-view="pick3"]');
  await p.check('onlyHit', true);
  const winRows = p.$$('#historyBody tr.row');
  const groupCol = p.$$('#historyHead th').map(th => th.textContent).indexOf('三中三组数');
  assert.ok(winRows.length >= 1);
  assert.ok(winRows.every(tr => tr.children[groupCol].textContent.trim() !== '0 组'), '仅看有奖期不应出现 0 组');
  assert.ok(winRows.every(tr => tr.classList.contains('row-hit')));
  assert.ok(winRows.every(tr => tr.textContent.includes('¥')));
  await p.check('onlyHit', false);
  // 加载更多
  await p.click(p.$$('#yearTabs .tab')[0]);
  assert.equal(p.$$('#historyBody tr.row').length, 50);
  await p.click('#historyMore');
  assert.equal(p.$$('#historyBody tr.row').length, 100);
  // 加载到底后按钮必须真正隐藏（作者样式 display:inline-flex 会覆盖 [hidden]，曾导致「点了没反应」）
  assert.equal(p.$('historyMore').hidden, true);
  assert.equal(p.window.getComputedStyle(p.$('historyMore')).display, 'none', '加载到底后「加载更多」仍可见');
  assert.equal(p.$('historyAll').hidden, false);
  assert.match(p.text('historyAll'), /已显示全部 100 期/);
  const before = p.$$('#specialList .special-item').length;
  assert.notEqual(p.window.getComputedStyle(p.$('specialMore')).display, 'none');
  await p.click('#specialMore');
  assert.equal(p.$$('#specialList .special-item').length, before + 30);
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('特码开奖记录按期展示：期号、波色球、日期、生肖与命中标记', { skip }, async () => {
  const p = await boot(snapshot);
  const items = p.$$('#specialList .special-item');
  assert.equal(items.length, 30);
  const first = items[0];
  assert.equal(first.querySelector('.sp-period').textContent, '2026-326');
  assert.equal(first.querySelector('.ball').textContent, '23');
  assert.ok(first.querySelector('.ball').classList.contains('red'), '特码球应带波色');
  assert.match(first.querySelector('.sp-meta').textContent, /11-22/);
  assert.match(first.querySelector('.sp-meta').textContent, /猴/);
  // 是否高亮完全取决于当期主推 7 码是否含特码：与回放结果逐期一致，不写死某一期
  const replay = p.get('replay');
  const shown = items.map(i => ({
    label: i.querySelector('.sp-period').textContent,
    hit: i.classList.contains('hit'),
    meta: i.querySelector('.sp-meta').textContent
  }));
  for (const item of shown) {
    const row = replay.find(r => r.label === item.label);
    assert.ok(row, '特码记录 ' + item.label + ' 应在回放中');
    assert.equal(item.hit, row.specialHit === true, item.label + ' 的特码命中高亮与回放不一致');
    assert.equal(item.meta.includes('7码中特'), item.hit, item.label + ' 的「7码中特」标注与高亮不一致');
  }
  assert.ok(shown.some(i => i.hit) && shown.some(i => !i.hit), '最近 30 期应同时存在命中与未中');
  // 由近到远排列
  const labels = items.map(i => i.querySelector('.sp-period').textContent);
  assert.deepEqual(labels, [...labels].sort().reverse());
  // 特码缺失时显示占位，不报错
  const legacy = { ...snapshot, draws: snapshot.draws.map(({ id, date, numbers }) => ({ id, date, numbers })) };
  const p2 = await boot(legacy, null, legacy);
  assert.ok(p2.html('specialList').includes('ball sm ghost'), '特码缺失应显示占位球');
  assert.match(p2.text('specialCount'), /已记录特码 0 期/);
  assert.match(p2.text('latestMeta'), /该期特码未记录/);
  assert.deepEqual(p2.errors, []);
  p.window.close(); p2.window.close();
});

test('开奖录入：真实输入 → 校验 → 保存 → 页面与本机数据更新 → 撤销', { skip }, async () => {
  const p = await boot(snapshot);
  const fill = async (nums, label) => {
    if (label !== undefined) await p.type('manualLabel', label);
    for (let i = 1; i <= 7; i++) await p.type('manualNum' + i, String(nums[i - 1]));
  };
  // 期号越界与格式
  await fill([3, 11, 22, 35, 41, 48, 7], '2026-999');
  assert.equal(p.$('manualDate').value, '', '越界期号不推算日期');
  await p.click('#manualSubmit');
  assert.match(p.text('manualFlash'), /2026 年最多 365 期/);
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.storage(), null, '校验失败不得写入本机');
  // 特码与正码重复
  await fill([3, 11, 22, 35, 41, 48, 48], '2026-327');
  await p.click('#manualSubmit');
  assert.match(p.text('manualFlash'), /互不重复/);
  // 粘贴自动填入
  await p.type('manualPaste', '03 11 22 35 41 48 + 07');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(i => p.$('manualNum' + i).value), ['03', '11', '22', '35', '41', '48', '07']);
  assert.equal(p.$('manualPaste').value, '');
  // 正常保存
  await p.click('#manualSubmit');
  assert.match(p.text('manualFlash'), /已保存 2026-327（2026-11-23）/);
  assert.equal(p.text('latestIssue'), '2026-327');
  assert.equal(p.text('latestDate'), '2026-11-23');
  assert.match(p.text('latestMeta'), /第 7 位特码 07/);
  assert.equal(p.$$('#latestBalls .ball-wrap')[6].querySelector('.ball').textContent, '07');
  assert.equal(p.text('targetIssue'), '2026-328');
  assert.equal(p.text('totalCount'), '1787');
  assert.equal(p.text('manualCount'), '手动记录 1 条');
  assert.equal(p.$('manualUndo').disabled, false);
  assert.equal(p.$('manualLabel').value, '2026-328', '保存后预填下一期');
  assert.equal(p.$('manualDate').value, '2026-11-24');
  assert.equal(p.$('manualNum1').value, '');
  assert.equal(p.$$('#specialList .special-item')[0].querySelector('.sp-period').textContent, '2026-327');
  const saved = p.storage();
  assert.equal(saved.schema, 2);
  assert.equal(saved.latestId, '2026-327');
  assert.deepEqual(saved.draws.at(-1), { id: '2026-327', date: '2026-11-23', numbers: [3, 11, 22, 35, 41, 48], special: 7, manual: true });
  assert.equal(saved.draws.at(-1).numbers.length, 6);
  // 新的一期进入历史命中（作为最新一行）
  assert.match(p.html('historyBody'), /2026-327/);
  // 撤销
  await p.click('#manualUndo');
  assert.match(p.text('manualFlash'), /已撤销手动记录 2026-327/);
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.text('manualCount'), '手动记录 0 条');
  assert.equal(p.$('manualUndo').disabled, true);
  assert.equal(p.storage().latestId, '2026-326');
  // 没有手动记录时再点撤销
  await p.click('#manualUndo');
  assert.match(p.text('manualFlash'), /没有可撤销/);
  // 清空输入
  await p.type('manualNum1', '9');
  await p.click('#manualClear');
  assert.equal(p.$('manualNum1').value, '');
  assert.match(p.text('manualFlash'), /已清空输入框/);
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('一键同步：真实点击后新增期次、带特码、写入本机并刷新各模块', { skip }, async () => {
  const p = await boot(remoteWithNext);
  assert.equal(p.text('latestIssue'), '2026-326');
  await p.click('#syncBtn');
  assert.equal(p.text('latestIssue'), '2026-327');
  assert.match(p.text('latestMeta'), /第 7 位特码 07/);
  assert.equal(p.text('targetIssue'), '2026-328');
  assert.match(p.text('syncStatus'), /新增 1 期/);
  assert.equal(p.$('syncBtn').disabled, false);
  assert.equal(p.$$('#specialList .special-item')[0].querySelector('.sp-period').textContent, '2026-327');
  const saved = p.storage();
  assert.equal(saved.draws.at(-1).special, 7);
  assert.equal(saved.draws.at(-1).manual, undefined);
  assert.deepEqual(p.errors, []);
  // 冲突时保持原样
  const conflict = { ...snapshot, draws: snapshot.draws.map(d => (d.id === '2026-326' ? { ...d, special: 1 } : d)) };
  const p2 = await boot(conflict);
  await p2.click('#syncBtn');
  assert.match(p2.text('syncStatus'), /特码冲突/);
  assert.equal(p2.text('latestIssue'), '2026-326');
  assert.equal(p2.storage().latestId, '2026-326', '冲突时不得写入新期次');
  assert.equal(p2.storage().draws.length, snapshot.draws.length - 1, '无效期 2022-132 不入库');
  assert.equal(p2.storage().lastSync.text, '失败', '失败也要记下，刷新后能看到');
  assert.deepEqual(p2.errors, []);
  p.window.close(); p2.window.close();
});

test('刷新后恢复本机数据：手动补录保留，本机备份与内置快照双向合并', { skip }, async () => {
  const drawItem = ({ id, date, numbers, special }) => ({ id, date, numbers, special });
  const manualPayload = JSON.stringify({
    schema: 2, updatedAt: snapshot.updatedAt, latestId: '2026-327', invalid: ['2022-132'],
    draws: [...snapshot.draws.map(drawItem), { id: '2026-327', date: '2026-11-23', numbers: [3, 11, 22, 35, 41, 48], special: 7, manual: true }]
  });
  const p = await boot(snapshot, { three_in_three_sync_v1: manualPayload });
  assert.equal(p.text('latestIssue'), '2026-327');
  assert.equal(p.text('totalCount'), '1787');
  assert.equal(p.text('manualCount'), '手动记录 1 条');
  assert.equal(p.$('manualUndo').disabled, false);
  assert.equal(p.text('targetIssue'), '2026-328');
  assert.match(p.text('syncStatus'), /本机手动补录 1 条，最新 2026-327/);
  assert.equal(p.$$('#latestBalls .ball-wrap')[6].querySelector('.ball').textContent, '07');
  assert.equal(p.$$('#specialList .special-item')[0].querySelector('.sp-period').textContent, '2026-327');
  // 撤销仍然可用
  await p.click('#manualUndo');
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.text('manualCount'), '手动记录 0 条');
  assert.deepEqual(p.errors, []);
  p.window.close();

  // 旧备份（无特码、期号落后于内置快照）→ 以内置为准补齐，不报「数据无效」，特码照常显示
  const legacyPayload = JSON.stringify({
    updatedAt: '2026-11-17T00:38:55.875Z', latestId: '2026-320', invalid: ['2022-132'],
    draws: snapshot.draws.filter(d => d.id <= '2026-320').map(({ id, date, numbers }) => ({ id, date, numbers }))
  });
  const p2 = await boot(snapshot, { three_in_three_sync_v1: legacyPayload });
  assert.equal(p2.text('latestIssue'), '2026-326');
  assert.doesNotMatch(p2.text('syncStatus'), /本机同步数据无效或有冲突/);
  assert.match(p2.text('latestMeta'), /第 7 位特码 23/);
  assert.equal(p2.text('manualCount'), '手动记录 0 条');
  assert.deepEqual(p2.errors, []);
  p2.window.close();
});

test('本机备份落后于内置快照时：手动补录与上次同步记录不再被静默丢弃', { skip }, async () => {
  // 用户 11-19 同步到 2026-323 并手动补录 2026-324；站点之后把内置快照更新到 2026-326。
  // 旧实现会让整份本机备份抛错作废（提示「落后于当前记录」），手动记录被忽略、lastSync 丢失，
  // 再点一次同步就把本机记录永久覆盖掉。
  const stale = JSON.stringify({
    schema: 2, updatedAt: '2026-11-19T22:00:00.000Z', latestId: '2026-324', invalid: [], rangeOk: true,
    lastSync: { at: '2026-11-19T22:05:00.000Z', text: '新增 3 期' },
    draws: [
      { id: '2026-324', date: '2026-11-20', numbers: [19, 4, 14, 12, 21, 34], special: 43, manual: true },
      ...snapshot.draws.filter(d => d.id <= '2026-323').map(({ id, date, numbers, special }) => ({ id, date, numbers, special }))
    ]
  });
  const p = await boot(snapshot, { three_in_three_sync_v1: stale });
  // 内置快照更新，页面以内置为准
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.text('totalCount'), '1786');
  // 手动记录已被官方收录（号码一致）→ 不再算手动，但必须给出说明而不是静默吞掉
  assert.equal(p.text('manualCount'), '手动记录 0 条');
  assert.match(p.text('syncStatus'), /1 条手动记录已被内置快照收录/);
  // 上次同步记录必须保留，不能被当成「数据无效」丢掉
  assert.match(p.text('syncStrip'), /新增 3 期/);
  assert.doesNotMatch(p.text('syncStatus'), /本机同步数据无效或有冲突/);
  assert.deepEqual(p.errors, []);
  p.window.close();

  // 同一份备份里若手动号码与官方不符，按官方数据计并明确提示
  const wrong = JSON.stringify({
    schema: 2, updatedAt: '2026-11-19T22:00:00.000Z', latestId: '2026-324', invalid: [],
    draws: [
      { id: '2026-324', date: '2026-11-20', numbers: [1, 2, 3, 4, 5, 6], special: 7, manual: true },
      ...snapshot.draws.filter(d => d.id <= '2026-323').map(({ id, date, numbers, special }) => ({ id, date, numbers, special }))
    ]
  });
  const p2 = await boot(snapshot, { three_in_three_sync_v1: wrong });
  assert.match(p2.text('syncStatus'), /2026-324 的手动补录与官方开奖号码不一致/);
  assert.match(p2.text('syncStatus'), /特码不一致（本机 07 \/ 官方 43）/);
  assert.deepEqual(p2.get("records.find(r => r.label === '2026-324').numbers"), [19, 4, 14, 12, 21, 34]);
  // 落盘后同样是官方数据，手动标记已清除
  await p2.click('#syncBtn');
  await p2.until(() => /已是最新/.test(p2.text('syncStatus')));
  const row = p2.storage().draws.find(d => d.id === '2026-324');
  assert.deepEqual(row.numbers, [19, 4, 14, 12, 21, 34]);
  assert.equal(row.manual, undefined);
  assert.deepEqual(p2.errors, []);
  p2.window.close();
});

/* ---------------- 同步透明度：为什么"点了同步却没变化" ---------------- */

// 上游比内置快照多 n 期的数据源（期号紧接 2026-326）
const EXTRA = [
  { id: '2026-327', year: 2026, period: '327', periodNum: 327, date: '2026-11-23', numbers: [3, 11, 22, 35, 41, 48], special: 7 },
  { id: '2026-328', year: 2026, period: '328', periodNum: 328, date: '2026-11-24', numbers: [6, 12, 19, 28, 33, 44], special: 15 }
];
const remotePlus = n => ({ ...snapshot, updatedAt: '2026-11-24T22:00:00.000Z', latestId: EXTRA[n - 1].id, draws: [...EXTRA.slice(0, n), ...snapshot.draws] });
// 上游文件开头 1 KB（真实文件里 latestId / updatedAt 都在开头，检查更新只读这一段）
const probeText = (latestId, updatedAt = '2026-11-24T22:00:00.000Z') =>
  JSON.stringify({ updatedAt, source: 'https://example/am.html', totalCount: 1789, latestId, latestDate: '2026-11-24', years: [2026], draws: [] }, null, 2).slice(0, 1024);

test('同步卡片：四格状态条说明本机/内置/上游/上次同步，未检查时不误报', { skip }, async () => {
  const p = await boot(snapshot);
  // 控件齐全：检查更新 + 一键同步 + 提示 pill + 状态条
  assert.ok(p.$('checkBtn'), '应有「检查更新」按钮');
  assert.match(p.text('checkBtn'), /检查更新/);
  assert.match(p.text('syncBtn'), /一键同步/);
  assert.equal(p.$('syncHint').hidden, true, '没有待同步期次时不显示提示');
  assert.equal(p.$('syncBtn').className, 'btn primary', '没有待同步期次时不高亮');
  const cells = p.cellTexts('syncStrip');
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map(c => c.k), ['本机最新期', '内置快照', '上游最新期', '上次同步']);
  assert.equal(cells[0].v, '2026-326');
  assert.match(cells[0].s, /2026-11-22 · 特码 23/);
  assert.ok(cells[0].cls.includes('accent'));
  assert.equal(cells[1].v, '2026-326');
  assert.match(cells[1].s, /更新于 2026-11-22 22:07 UTC/, '内置快照应给出数据时间');
  assert.equal(cells[2].v, '未检查', '没点过检查/同步前不应假装知道上游状态');
  assert.match(cells[2].s, /点「检查更新」或「一键同步」/);
  assert.equal(cells[3].v, '尚未同步');
  assert.match(cells[3].s, /本机数据来自内置快照/);
  assert.ok(!cells.some(c => c.cls.includes('alert')), '无待同步期次时不应告警配色');
  // 初始说明必须解释「检查更新很便宜、同步才写入」
  assert.match(p.text('syncStatus'), /内置快照到 2026-326/);
  assert.match(p.text('syncStatus'), /点「检查更新」（约 1 KB，不写入）/);
  assert.match(p.text('syncStatus'), /要写入再点「一键同步」/);
  assert.equal(p.requests.length, 1, '首屏只读内置快照，不应自动下载上游完整数据');
  assert.equal(p.requests[0].ranged, false);
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('检查更新：上游多 2 期 → 只读 1 KB 说明差几期并高亮同步键，不写入数据', { skip }, async () => {
  const p = await boot(remotePlus(2), null, null, { probe: { status: 206, text: probeText('2026-328') } });
  await p.click('#checkBtn');
  await p.until(() => /上游已更新到 2026-328/.test(p.text('syncStatus')));
  // 只发了一次分段请求，且带 Range 与 no-store（不吃 Service Worker 旧缓存）
  const probes = p.requests.filter(r => r.ranged);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].range, 'bytes=0-1023');
  assert.equal(probes[0].cache, 'no-store');
  assert.match(p.text('syncStatus'), /🔔 上游已更新到 2026-328/);
  assert.match(p.text('syncStatus'), /本机停在 2026-326，差 2 期/);
  assert.match(p.text('syncStatus'), /点「一键同步」写入/);
  assert.equal(p.text('syncHint'), '上游有 2 期可同步');
  assert.equal(p.$('syncHint').hidden, false);
  assert.ok(p.$('syncBtn').className.includes('attention'), '有待同步期次时应高亮同步按钮');
  const cells = p.cellTexts('syncStrip');
  assert.equal(cells[2].v, '2026-328');
  assert.ok(cells[2].cls.includes('alert'), '上游更新应使用告警配色');
  assert.equal(cells[3].v, '尚未同步', '检查更新不算同步');
  // 关键：检查更新绝不改动数据
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.text('targetIssue'), '2026-327');
  assert.equal(p.text('totalCount'), '1786');
  assert.equal(p.storage().latestId, '2026-326', '检查更新只记元信息，不新增期次');
  assert.equal(p.storage().rangeOk, true, '应记住上游支持分段请求，下次自动检查');
  assert.equal(p.$('checkBtn').disabled, false);
  assert.equal(p.$('syncBtn').disabled, false);
  assert.deepEqual(p.errors, []);
  // 接着点一键同步：写入 2 期并清掉提示
  await p.click('#syncBtn');
  await p.until(() => p.text('latestIssue') === '2026-328');
  assert.equal(p.text('latestIssue'), '2026-328');
  assert.equal(p.text('targetIssue'), '2026-329');
  assert.equal(p.text('totalCount'), '1788');
  assert.match(p.text('syncStatus'), /✅ 同步完成：新增 2 期（2026-327、2026-328）/);
  assert.match(p.text('syncStatus'), /特码 15/);
  assert.match(p.text('syncStatus'), /上游更新于 2026-11-24 22:00 UTC/);
  assert.equal(p.$('syncHint').hidden, true);
  assert.equal(p.$('syncBtn').className, 'btn primary');
  const after = p.cellTexts('syncStrip');
  assert.equal(after[2].v, '2026-328');
  assert.ok(!after[2].cls.includes('alert'), '同步完成后不再告警');
  assert.equal(after[3].k, '上次同步');
  assert.equal(after[3].v, '新增 2 期');
  assert.match(after[3].s, /UTC$/);
  assert.equal(p.storage().latestId, '2026-328');
  assert.equal(p.storage().lastSync.text, '新增 2 期');
  assert.equal(p.storage().draws.at(-1).special, 15);
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('检查更新：上游与本机同期 → 明确解释"没有新期次可加"而不是静默无反应', { skip }, async () => {
  const p = await boot(snapshot, null, null, { probe: { status: 206, text: probeText('2026-326', snapshot.updatedAt) } });
  await p.click('#checkBtn');
  await p.until(() => /已是最新/.test(p.text('syncStatus')));
  assert.match(p.text('syncStatus'), /✅ 已是最新：上游与本机同为 2026-326/);
  assert.match(p.text('syncStatus'), /没有新期次可加/);
  assert.match(p.text('syncStatus'), /上游一般每天开奖后更新一期/);
  assert.match(p.text('syncStatus'), /UTC 22:00 前后/);
  assert.equal(p.$('syncHint').hidden, true);
  assert.equal(p.$('syncBtn').className, 'btn primary');
  assert.ok(!p.cellTexts('syncStrip').some(c => c.cls.includes('alert')));
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.text('totalCount'), '1786');
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('一键同步到同期数据：说明"已是最新"，并写回上次同步时间', { skip }, async () => {
  const p = await boot(snapshot);
  await p.click('#syncBtn');
  await p.until(() => /已是最新，没有新期次可加/.test(p.text('syncStatus')));
  assert.match(p.text('syncStatus'), /✅ 已是最新，没有新期次可加：本机与上游同为 2026-326（2026-11-22），特码 23/);
  assert.match(p.text('syncStatus'), /上游数据更新于 2026-11-22 22:07 UTC/);
  assert.match(p.text('syncStatus'), /等发布后再点即可/);
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.$('syncBtn').disabled, false);
  const cells = p.cellTexts('syncStrip');
  assert.equal(cells[2].v, '2026-326');
  assert.equal(cells[3].v, '已是最新');
  assert.equal(p.storage().lastSync.text, '已是最新');
  assert.equal(p.storage().latestId, '2026-326');
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('上游忽略分段请求：检查更新自动转为一次完整同步，不浪费已下载的流量', { skip }, async () => {
  const full = remotePlus(2);
  const p = await boot(full, null, null, { probe: { status: 200, text: JSON.stringify(full) } });
  await p.click('#checkBtn');
  await p.until(() => p.text('latestIssue') === '2026-328');
  assert.match(p.text('syncStatus'), /检查更新时上游直接返回了完整数据，已顺手完成同步/);
  assert.match(p.text('syncStatus'), /✅ 同步完成：新增 2 期（2026-327、2026-328）/);
  assert.equal(p.text('latestIssue'), '2026-328');
  assert.equal(p.text('totalCount'), '1788');
  assert.equal(p.storage().rangeOk, false, '上游不支持分段请求，下次不再自动检查');
  assert.equal(p.storage().lastSync.text, '新增 2 期');
  assert.equal(p.$('syncHint').hidden, true);
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('本机已超前上游（手动补录）：检查更新与一键同步都说明原因且不写入', { skip }, async () => {
  const drawItem = ({ id, date, numbers, special }) => ({ id, date, numbers, special });
  const ahead = JSON.stringify({
    schema: 2, updatedAt: snapshot.updatedAt, latestId: '2026-327', invalid: ['2022-132'],
    draws: [...snapshot.draws.map(drawItem), { ...drawItem(EXTRA[0]), manual: true }]
  });
  const p = await boot(snapshot, { three_in_three_sync_v1: ahead }, null, { probe: { status: 206, text: probeText('2026-326', snapshot.updatedAt) } });
  assert.equal(p.text('latestIssue'), '2026-327', '本机手动补录应保留');
  await p.click('#checkBtn');
  await p.until(() => /本机已超前上游/.test(p.text('syncStatus')));
  assert.match(p.text('syncStatus'), /ℹ️ 本机已超前上游：本机 2026-327，上游 2026-326/);
  assert.match(p.text('syncStatus'), /无需同步/);
  assert.equal(p.cellTexts('syncStrip')[3].k, '本机已超前上游');
  assert.equal(p.$('syncHint').hidden, true);
  await p.click('#syncBtn');
  await p.until(() => /无需同步/.test(p.text('syncStatus')));
  assert.match(p.text('syncStatus'), /ℹ️ 无需同步：本机最新期 2026-327 已超前上游 2026-326，未写入任何数据/);
  assert.match(p.text('syncStatus'), /号码与官方不一致时会提示冲突/);
  assert.equal(p.text('latestIssue'), '2026-327');
  assert.equal(p.text('totalCount'), '1787');
  assert.equal(p.storage().latestId, '2026-327');
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('网络失败：同步与检查更新都保留现有数据，并给出可读原因', { skip }, async () => {
  const p = await boot(snapshot, null, null, { netError: 'Failed to fetch' });
  await p.click('#syncBtn');
  await p.until(() => /同步失败/.test(p.text('syncStatus')));
  assert.match(p.text('syncStatus'), /❌ 同步失败，未更改现有数据：Failed to fetch/);
  assert.match(p.text('syncStatus'), /请检查网络、数据源或期号后重试/);
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.text('targetIssue'), '2026-327');
  assert.equal(p.$('syncBtn').disabled, false, '失败后按钮应可再次点击');
  assert.equal(p.cellTexts('syncStrip')[3].v, '失败');
  assert.equal(p.storage().lastSync.text, '失败', '失败也记下，刷新后仍能看到');
  assert.equal(p.storage().latestId, '2026-326');
  await p.click('#checkBtn');
  await p.until(() => /检查更新失败/.test(p.text('syncStatus')));
  assert.match(p.text('syncStatus'), /❌ 检查更新失败：Failed to fetch/);
  assert.match(p.text('syncStatus'), /可直接点「一键同步」/);
  assert.equal(p.text('latestIssue'), '2026-326');
  assert.equal(p.$('checkBtn').disabled, false);
  assert.deepEqual(p.errors, []);
  p.window.close();
});

test('刷新后：记住上次同步结果，上游支持分段请求时自动检查更新并提示差几期', { skip }, async () => {
  // 第一次访问：检查更新 → 一键同步，本机记下 lastSync 与 rangeOk
  const p1 = await boot(remotePlus(1), null, null, { probe: { status: 206, text: probeText('2026-327', '2026-11-23T22:00:00.000Z') } });
  await p1.click('#checkBtn');
  await p1.until(() => /差 1 期/.test(p1.text('syncStatus')));
  assert.match(p1.text('syncStatus'), /差 1 期/);
  await p1.click('#syncBtn');
  await p1.until(() => p1.text('latestIssue') === '2026-327');
  assert.equal(p1.text('latestIssue'), '2026-327');
  const saved = p1.storage();
  assert.equal(saved.rangeOk, true);
  assert.equal(saved.lastSync.text, '新增 1 期');
  assert.equal(saved.latestId, '2026-327');
  p1.window.close();

  // 第二天再打开：上游又多了一期，页面自动检查并提示，无需用户先点任何按钮
  const p2 = await boot(remotePlus(2), { three_in_three_sync_v1: JSON.stringify(saved) }, null,
    { probe: { status: 206, text: probeText('2026-328') } });
  await p2.until(() => /上游已更新到 2026-328/.test(p2.text('syncStatus')));
  assert.equal(p2.text('latestIssue'), '2026-327', '自动检查不应擅自写入数据');
  assert.match(p2.text('syncStatus'), /🔔 上游已更新到 2026-328/);
  assert.match(p2.text('syncStatus'), /本机停在 2026-327，差 1 期/);
  assert.equal(p2.text('syncHint'), '上游有 1 期可同步');
  assert.ok(p2.$('syncBtn').className.includes('attention'));
  const cells = p2.cellTexts('syncStrip');
  assert.equal(cells[1].v, '2026-326', '内置快照仍是打包时的那一期');
  assert.equal(cells[2].v, '2026-328');
  assert.equal(cells[3].v, '新增 1 期', '应恢复上次同步结果');
  assert.equal(p2.requests.filter(r => r.ranged).length, 1, '自动检查只读文件开头');
  assert.ok(!p2.requests.some(r => !r.ranged && String(r.url).startsWith('http')), '自动检查不应下载完整上游数据');
  await p2.click('#syncBtn');
  await p2.until(() => p2.text('latestIssue') === '2026-328');
  assert.equal(p2.text('latestIssue'), '2026-328');
  assert.match(p2.text('syncStatus'), /✅ 同步完成：新增 1 期（2026-328）/);
  assert.equal(p2.$('syncHint').hidden, true);
  assert.deepEqual(p2.errors, []);
  p2.window.close();
});

test('离线打包：sw.js 缓存版本随数据提升，且上游开奖数据始终直连不吃缓存', { skip }, () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  assert.match(sw, /const CACHE_NAME='three-in-three-v8'/);
  assert.match(app, /const APP_BUILD = '2026\.11\.23-r8'/);
  // 缓存清单包含数据与三个脚本
  for (const asset of ['./index.html', './src/app.js', './src/data.js', './src/engine.js', './data/draws.json']) {
    assert.ok(sw.includes(`'${asset}'`), 'sw.js 预缓存清单缺少 ' + asset);
  }
  // 关键修复：上游数据与本工具同域，必须绕过缓存，否则同步会读到旧数据
  const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"));
  const bypass = fetchHandler.indexOf('/Number-selection-tool/');
  const cacheMatch = fetchHandler.indexOf('caches.match');
  assert.ok(bypass > 0, 'sw.js 应放行上游数据请求');
  assert.ok(bypass < cacheMatch, '放行判断必须在读缓存之前');
  assert.match(fetchHandler, /if\(url\.pathname\.indexOf\('\/Number-selection-tool\/'\)===0\) return;/);
  // 内置快照与上游最新期一致，避免"打包即过期"
  assert.equal(snapshot.latestId, '2026-326');
  assert.equal(snapshot.draws.length, 1787);
});
