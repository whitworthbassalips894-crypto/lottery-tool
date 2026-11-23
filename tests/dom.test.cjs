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
const NEXT = { id: '2026-325', year: 2026, period: '325', periodNum: 325, date: '2026-11-21', numbers: [3, 11, 22, 35, 41, 48], special: 7 };
const remoteWithNext = { ...snapshot, updatedAt: '2026-11-21T22:00:00.000Z', latestId: '2026-325', draws: [NEXT, ...snapshot.draws] };

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

async function boot(remote, storage, builtin) {
  const local = builtin || snapshot;
  const errors = [], copied = [];
  const dom = new JSDOM(pageHtml(), {
    runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async url => ({ ok: true, status: 200, json: async () => (String(url).startsWith('http') ? remote : local) });
      window.addEventListener('error', e => errors.push(String((e.error && e.error.stack) || e.message)));
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async t => copied.push(t) }, configurable: true });
      for (const [k, v] of Object.entries(storage || {})) window.localStorage.setItem(k, v);
    }
  });
  await wait(420);
  const window = dom.window, document = window.document;
  const api = {
    dom, window, document, errors, copied,
    $: id => document.getElementById(id),
    q: sel => document.querySelector(sel),
    $$: sel => Array.from(document.querySelectorAll(sel)),
    text: id => (document.getElementById(id) ? document.getElementById(id).textContent : null),
    html: id => (document.getElementById(id) ? document.getElementById(id).innerHTML : null),
    click: sel => {
      const node = typeof sel === 'string' ? document.querySelector(sel) : sel;
      assert.ok(node, '找不到可点击元素：' + sel);
      node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return wait(140);
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
  assert.equal(p.text('totalCount'), '1784');
  assert.equal(p.text('latestIssue'), '2026-324');
  assert.equal(p.text('latestDate'), '2026-11-20');
  assert.match(p.text('latestMeta'), /第 7 位特码 43/);
  const wraps = p.$$('#latestBalls .ball-wrap');
  assert.equal(wraps.length, 7, '最新开奖应有 7 个带标签的号码球');
  assert.deepEqual(wraps.slice(0, 6).map(w => w.querySelector('.ball-label').textContent), ['正1', '正2', '正3', '正4', '正5', '正6']);
  const lastWrap = wraps[6];
  assert.equal(lastWrap.querySelector('.ball-label').textContent, '特码');
  assert.equal(lastWrap.querySelector('.ball-label').className, 'ball-label special');
  assert.equal(lastWrap.querySelector('.ball').textContent, '43');
  assert.ok(lastWrap.querySelector('.ball').classList.contains('is-special'));
  assert.ok(p.q('#latestBalls .ball-plus'), '平码与特码之间应有分隔符');
  assert.equal(p.$$('#statStrip .stat-cell').length, 5);
  assert.match(p.$('statStrip').textContent, /近100期7码中特/);
  assert.equal(p.text('targetIssue'), '2026-325');
  assert.equal(p.$$('#recommendBalls .ball').length, 7);
  assert.equal(p.$$('#recommendComposition .chip').length, 4);
  assert.match(p.text('recommendPicks'), /每日随机/);
  assert.equal(p.$$('#recommendPicks .chip').length, 7);
  assert.match(p.$('recommendPicks').textContent, /同一期永远同一组/);
  assert.equal(p.$$('#specialList .special-item').length, 30);
  assert.match(p.text('specialCount'), /共 1784 期 · 已记录特码 1784 期 · 显示 30 期/);
  assert.equal(p.$$('#historyBody tr.row').length, 50);
  assert.equal(p.$$('#historyHead th').length, 5);
  assert.match(p.text('syncStatus'), /特码 43/);
  assert.equal(p.$('manualLabel').value, '2026-325');
  assert.equal(p.$('manualDate').value, '2026-11-21');
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
  assert.equal(p.$('historyMore').hidden, true);
  const before = p.$$('#specialList .special-item').length;
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
  assert.equal(first.querySelector('.sp-period').textContent, '2026-324');
  assert.equal(first.querySelector('.ball').textContent, '43');
  assert.ok(first.querySelector('.ball').classList.contains('green'), '特码球应带波色');
  assert.match(first.querySelector('.sp-meta').textContent, /11-20/);
  assert.match(first.querySelector('.sp-meta').textContent, /鼠/);
  // 是否高亮完全取决于当期主推 7 码是否含特码：与回放结果逐期一致，不写死某一期
  const firstRow = p.$$('#specialList .special-item')[0];
  const firstLabel = firstRow.querySelector('.sp-period').textContent;
  const replayRow = p.get('replay').find(r => r.label === firstLabel);
  assert.equal(firstRow.classList.contains('hit'), replayRow.specialHit === true, firstLabel + ' 的特码命中高亮与回放不一致');
  if (replayRow.specialHit) assert.match(first.querySelector('.sp-meta').textContent, /7码中特/);
  else assert.doesNotMatch(first.querySelector('.sp-meta').textContent, /7码中特/);
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
  assert.equal(p.text('latestIssue'), '2026-324');
  assert.equal(p.storage(), null, '校验失败不得写入本机');
  // 特码与正码重复
  await fill([3, 11, 22, 35, 41, 48, 48], '2026-325');
  await p.click('#manualSubmit');
  assert.match(p.text('manualFlash'), /互不重复/);
  // 粘贴自动填入
  await p.type('manualPaste', '03 11 22 35 41 48 + 07');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(i => p.$('manualNum' + i).value), ['03', '11', '22', '35', '41', '48', '07']);
  assert.equal(p.$('manualPaste').value, '');
  // 正常保存
  await p.click('#manualSubmit');
  assert.match(p.text('manualFlash'), /已保存 2026-325（2026-11-21）/);
  assert.equal(p.text('latestIssue'), '2026-325');
  assert.equal(p.text('latestDate'), '2026-11-21');
  assert.match(p.text('latestMeta'), /第 7 位特码 07/);
  assert.equal(p.$$('#latestBalls .ball-wrap')[6].querySelector('.ball').textContent, '07');
  assert.equal(p.text('targetIssue'), '2026-326');
  assert.equal(p.text('totalCount'), '1785');
  assert.equal(p.text('manualCount'), '手动记录 1 条');
  assert.equal(p.$('manualUndo').disabled, false);
  assert.equal(p.$('manualLabel').value, '2026-326', '保存后预填下一期');
  assert.equal(p.$('manualDate').value, '2026-11-22');
  assert.equal(p.$('manualNum1').value, '');
  assert.equal(p.$$('#specialList .special-item')[0].querySelector('.sp-period').textContent, '2026-325');
  const saved = p.storage();
  assert.equal(saved.schema, 2);
  assert.equal(saved.latestId, '2026-325');
  assert.deepEqual(saved.draws.at(-1), { id: '2026-325', date: '2026-11-21', numbers: [3, 11, 22, 35, 41, 48], special: 7, manual: true });
  assert.equal(saved.draws.at(-1).numbers.length, 6);
  // 新的一期进入历史命中（作为最新一行）
  assert.match(p.html('historyBody'), /2026-325/);
  // 撤销
  await p.click('#manualUndo');
  assert.match(p.text('manualFlash'), /已撤销手动记录 2026-325/);
  assert.equal(p.text('latestIssue'), '2026-324');
  assert.equal(p.text('manualCount'), '手动记录 0 条');
  assert.equal(p.$('manualUndo').disabled, true);
  assert.equal(p.storage().latestId, '2026-324');
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
  assert.equal(p.text('latestIssue'), '2026-324');
  await p.click('#syncBtn');
  assert.equal(p.text('latestIssue'), '2026-325');
  assert.match(p.text('latestMeta'), /第 7 位特码 07/);
  assert.equal(p.text('targetIssue'), '2026-326');
  assert.match(p.text('syncStatus'), /新增 1 期/);
  assert.equal(p.$('syncBtn').disabled, false);
  assert.equal(p.$$('#specialList .special-item')[0].querySelector('.sp-period').textContent, '2026-325');
  const saved = p.storage();
  assert.equal(saved.draws.at(-1).special, 7);
  assert.equal(saved.draws.at(-1).manual, undefined);
  assert.deepEqual(p.errors, []);
  // 冲突时保持原样
  const conflict = { ...snapshot, draws: snapshot.draws.map(d => (d.id === '2026-324' ? { ...d, special: 1 } : d)) };
  const p2 = await boot(conflict);
  await p2.click('#syncBtn');
  assert.match(p2.text('syncStatus'), /特码冲突/);
  assert.equal(p2.text('latestIssue'), '2026-324');
  assert.equal(p2.storage(), null);
  assert.deepEqual(p2.errors, []);
  p.window.close(); p2.window.close();
});

test('刷新后恢复本机数据：手动补录保留，旧备份落后时回退内置快照', { skip }, async () => {
  const drawItem = ({ id, date, numbers, special }) => ({ id, date, numbers, special });
  const manualPayload = JSON.stringify({
    schema: 2, updatedAt: snapshot.updatedAt, latestId: '2026-325', invalid: ['2022-132'],
    draws: [...snapshot.draws.map(drawItem), { id: '2026-325', date: '2026-11-21', numbers: [3, 11, 22, 35, 41, 48], special: 7, manual: true }]
  });
  const p = await boot(snapshot, { three_in_three_sync_v1: manualPayload });
  assert.equal(p.text('latestIssue'), '2026-325');
  assert.equal(p.text('totalCount'), '1785');
  assert.equal(p.text('manualCount'), '手动记录 1 条');
  assert.equal(p.$('manualUndo').disabled, false);
  assert.equal(p.text('targetIssue'), '2026-326');
  assert.match(p.text('syncStatus'), /本机手动补录 1 条，最新 2026-325/);
  assert.equal(p.$$('#latestBalls .ball-wrap')[6].querySelector('.ball').textContent, '07');
  assert.equal(p.$$('#specialList .special-item')[0].querySelector('.sp-period').textContent, '2026-325');
  // 撤销仍然可用
  await p.click('#manualUndo');
  assert.equal(p.text('latestIssue'), '2026-324');
  assert.equal(p.text('manualCount'), '手动记录 0 条');
  assert.deepEqual(p.errors, []);
  p.window.close();

  // 改版前的旧备份（无特码、期号落后于内置快照）→ 回退内置数据并提示，特码照常显示
  const legacyPayload = JSON.stringify({
    updatedAt: '2026-11-17T00:38:55.875Z', latestId: '2026-320', invalid: ['2022-132'],
    draws: snapshot.draws.filter(d => d.id <= '2026-320').map(({ id, date, numbers }) => ({ id, date, numbers }))
  });
  const p2 = await boot(snapshot, { three_in_three_sync_v1: legacyPayload });
  assert.equal(p2.text('latestIssue'), '2026-324');
  assert.match(p2.text('syncStatus'), /本机同步数据无效或有冲突，已使用内置数据/);
  assert.match(p2.text('syncStatus'), /落后于当前记录/);
  assert.match(p2.text('latestMeta'), /第 7 位特码 43/);
  assert.equal(p2.text('manualCount'), '手动记录 0 条');
  assert.deepEqual(p2.errors, []);
  p2.window.close();
});
