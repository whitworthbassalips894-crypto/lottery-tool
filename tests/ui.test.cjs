'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const snapshot = require('../data/draws.json');

// 轻量假 DOM：沿用原有夹具，另外支持 value/hidden/placeholder 赋值与 vm 直接调用页面函数。
function setup(remote, builtin) {
  const local = builtin || snapshot;
  const elems = new Map();
  const store = new Map([['kl8_manual_draws_v1', 'sensitive'], ['kl8_recommended_budget_v1', '10'], ['other_app', 'keep']]);
  const get = id => {
    if (!elems.has(id)) {
      const e = {
        id, textContent: '', innerHTML: '', value: '', placeholder: '', hidden: false, disabled: false,
        style: {}, events: {}, className: '',
        addEventListener(name, fn) { this.events[name] = fn; },
        setAttribute() {}, querySelectorAll() { return []; }, remove() {}, select() {}, focus() {}
      };
      elems.set(id, e);
    }
    return elems.get(id);
  };
  const document = { getElementById: get, createElement: get, body: { append() {} }, execCommand() { return true; } };
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const clipboard = [];
  const sandbox = {
    document, localStorage: storage,
    navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    location: { protocol: 'http:' },
    fetch: async url => ({ ok: true, status: 200, json: async () => (String(url).startsWith('http') ? remote : local) }),
    setTimeout: () => 0, console
  };
  vm.createContext(sandbox);
  for (const f of ['src/engine.js', 'src/data.js', 'src/app.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
  const call = (expr, file = 'inline.js') => vm.runInContext(expr, sandbox, { filename: file });
  return { sandbox, get, store, clipboard, call };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const count = (html, needle) => String(html).split(needle).length - 1;
const NEXT = { id: '2026-327', date: '2026-11-23', numbers: [3, 11, 22, 35, 41, 48], special: 7 };
const remoteWithNext = { ...snapshot, updatedAt: '2026-11-23T22:00:00.000Z', latestId: '2026-327', draws: [NEXT, ...snapshot.draws] };

test('页面初始化：清除旧快乐8数据、展示最新一期含第7位特码', async () => {
  const ctx = setup(remoteWithNext);
  await flush();
  assert.equal(ctx.store.has('kl8_manual_draws_v1'), false);
  assert.equal(ctx.store.has('kl8_recommended_budget_v1'), false);
  assert.equal(ctx.store.has('kl8_pick_mode_v1'), false);
  assert.equal(ctx.store.get('other_app'), 'keep');
  assert.equal(ctx.get('totalCount').textContent, 1786);
  assert.equal(ctx.get('latestIssue').textContent, '2026-326');
  assert.equal(ctx.get('latestDate').textContent, '2026-11-22');
  assert.equal(ctx.get('targetIssue').textContent, '2026-327');
  assert.equal(ctx.get('copyBtn').disabled, false);
  assert.match(ctx.get('latestMeta').textContent, /第 1~6 位平码 \+ 第 7 位特码 23/);
  // 最新开奖：6 个平码带「正1~正6」标签，第 7 位单独放大并标注「特码」
  const balls = ctx.get('latestBalls').innerHTML;
  assert.equal(count(balls, 'ball-label'), 7);
  for (let i = 1; i <= 6; i++) assert.ok(balls.includes(`>正${i}<`), '缺少正' + i + '标注');
  assert.equal(count(balls, '>特码<'), 1);
  assert.match(balls, /ball-label special">特码</);
  assert.match(balls, /ball blue lg">09</);
  assert.match(balls, /ball red lg is-special">23</);
  assert.match(balls, /ball-plus/);
  assert.match(ctx.get('syncStatus').textContent, /特码 23/);
  assert.match(ctx.get('syncStatus').textContent, /1 期前6码无效未参与统计：2022-132/);
  assert.equal(ctx.get('buildTag').textContent, ctx.call('APP_BUILD'));
  // 推荐 7 码与关键指标条
  assert.equal((ctx.get('recommendBalls').innerHTML.match(/class="ball (?:red|blue|green) lg"/g) || []).length, 7);
  assert.equal(count(ctx.get('recommendComposition').innerHTML, 'chip'), 4);
  // 固定 7 码口径：号码来自 engine 的 FIXED_SEVEN，明细给出波色与生肖，没有热冷/遗漏指标
  const picks = ctx.get('recommendPicks').innerHTML;
  assert.match(picks, /固定 7 码/);
  assert.match(picks, /号码固定/);
  assert.equal(count(picks, 'chip'), 7);
  assert.doesNotMatch(picks, /遗漏|出现次数|种子/);
  const recommend = ctx.call('recommendation');
  assert.equal(recommend.picks.length, 7);
  assert.equal(recommend.picks.map(x => x.num).sort((a, b) => a - b).join(','), Array.from(recommend.numbers).join(','));
  assert.equal(Array.from(recommend.numbers).join(','), Array.from(ctx.call('FIXED_SEVEN')).join(','));
  // 换一批数据/换期号，号码都不变
  const again = setup(remoteWithNext);
  await flush();
  assert.equal(Array.from(again.call('recommendation').numbers).join(','), Array.from(recommend.numbers).join(','));
  const strip = ctx.get('statStrip').innerHTML;
  assert.match(strip, /有效期开奖/);
  assert.match(strip, /下期目标期/);
  assert.match(strip, /近100期三中三有奖/);
  assert.match(strip, /近100期7码中特/);
});

test('特码开奖记录按期展示：期号、特码球、日期、生肖与7码中特标记', async () => {
  const ctx = setup(snapshot);
  await flush();
  const html = ctx.get('specialList').innerHTML;
  assert.equal(count(html, 'special-item'), 30);
  assert.equal(count(html, 'special-item hit'), count(html, '7码中特'));
  assert.ok(html.indexOf('2026-326') < html.indexOf('2026-325'), '应按期号由近到远排列');
  assert.match(html, /2026-326[\s\S]{0,220}?ball red sm">23</);
  assert.match(html, /11-20/);
  assert.match(html, /鼠/);
  assert.match(ctx.get('specialCount').textContent, /共 1786 期 · 已记录特码 1786 期 · 显示 30 期/);
  assert.equal(ctx.get('specialMore').hidden, false);
  ctx.get('specialMore').events.click();
  assert.equal(count(ctx.get('specialList').innerHTML, 'special-item'), 60);
  assert.match(ctx.get('specialCount').textContent, /显示 60 期/);
});

test('历史命中默认特码视图：表头、指标卡与逐期徽标', async () => {
  const ctx = setup(snapshot);
  await flush();
  assert.match(ctx.get('historyHead').innerHTML, /7码中特/);
  assert.match(ctx.get('historyHead').innerHTML, /连错期数/);
  assert.match(ctx.get('historyHead').innerHTML, /开奖号码（末位特码）/);
  assert.match(ctx.get('historyNote').innerHTML, /不折算金额/);
  assert.equal(ctx.get('onlyHitLabel').textContent, '仅看命中特码');
  assert.equal(ctx.get('historyScopeTag').textContent, '近100期');
  assert.equal(ctx.get('filterCount').textContent, '100 期');
  const summary = ctx.get('summary').innerHTML;
  assert.match(summary, /7码中特 · 命中率/);
  assert.match(summary, /随机基线 14\.3%/);
  assert.match(summary, /平均间隔/);
  assert.match(summary, /当前连错/);
  assert.match(summary, /同范围三中三（对照）/);
  const body = ctx.get('historyBody').innerHTML;
  assert.equal(count(body, '<tr class="row'), 50);
  assert.ok(count(body, '✓ 7码中特') >= 1, '近100期应至少有 1 期命中特码');
  assert.ok(count(body, 'badge lose') >= 1);
  assert.match(body, /num special (red|blue|green)/);
  assert.equal(ctx.get('historyMore').hidden, false);
  ctx.get('historyMore').events.click();
  assert.equal(count(ctx.get('historyBody').innerHTML, '<tr class="row'), 100);
  assert.equal(ctx.get('historyMore').hidden, true);
  // 年份范围切换
  ctx.call('selectedScope = "2025"; historyLimit = HISTORY_PAGE; renderHistory()');
  assert.equal(ctx.get('historyScopeTag').textContent, '2025年');
  assert.match(ctx.get('filterCount').textContent, /365 期/);
});

test('切换到三中三视图：金额口径不变，且「7码中特」列与卡片常驻', async () => {
  const ctx = setup(snapshot);
  await flush();
  ctx.call('switchView("pick3")');
  const head = ctx.get('historyHead').innerHTML;
  for (const col of ['期号 / 日期', '开奖号码（末位特码）', '主推 7 码', '命中平码', '三中三组数', '7码中特', '模拟奖金']) {
    assert.ok(head.includes(col), '三中三视图缺少列：' + col);
  }
  assert.equal(ctx.get('onlyHitLabel').textContent, '仅看有奖期');
  assert.match(ctx.get('historyNote').innerHTML, /C\(命中平码数, 3\)/);
  const summary = ctx.get('summary').innerHTML;
  assert.match(summary, /有奖期占比/);
  assert.match(summary, /35 组 × 2 元 = 70 元/);
  assert.match(summary, /2 元 × 700 = 1,400 元/);
  assert.match(summary, /模拟盈亏/);
  assert.match(summary, /7码中特 · 常驻记录/);
  assert.match(summary, /切换视图不丢失/);
  // 固定 7 码也必须在指标卡上给出随机对照，避免被误读成「更准」
  assert.match(summary, /平均每期命中 <b>0\.\d\d\d<\/b> 个平码（随机基线 0\.857）/);
  assert.match(summary, /随机理论 3\.10%/);
  assert.match(summary, /固定 7 码/);
  const body = ctx.get('historyBody').innerHTML;
  assert.match(body, /¥(?:0|1,400|5,600|14,000|28,000)/);
  assert.ok(count(body, '✓ 7码中特') >= 1, '三中三视图必须继续显示特码命中');
  assert.ok(body.includes('badge win') || body.includes('badge lose'));
  // 展开明细：同时给出三中三组合与当期特码
  ctx.call('expanded = replay.at(-1).label; renderHistory()');
  const detail = ctx.get('historyBody').innerHTML;
  assert.match(detail, /<tr class="detail"><td colspan="7">/);
  assert.match(detail, /命中组合/);
  assert.match(detail, /当期特码/);
  assert.match(detail, /7码中特：/);
  assert.match(detail, /模拟盈亏 -¥70|模拟盈亏 ¥/);
  // 特码视图的明细同样带三中三信息（switchView 会收起展开行，需重新展开）
  ctx.call('switchView("special"); expanded = replay.at(-1).label; renderHistory()');
  assert.match(ctx.get('historyBody').innerHTML, /<tr class="detail"><td colspan="5">/);
  assert.match(ctx.get('historyBody').innerHTML, /三中三/);
});

test('搜索与「仅看命中」筛选：两种视图各自口径', async () => {
  const ctx = setup(snapshot);
  await flush();
  ctx.call('query = "2026-320"; renderHistory()');
  assert.match(ctx.get('filterCount').textContent, /筛出 1 \/ 100 期/);
  assert.match(ctx.get('historyBody').innerHTML, /2026-320/);
  ctx.call('query = ""; onlyHit = true; renderHistory()');
  const specialOnly = ctx.get('historyBody').innerHTML;
  assert.ok(count(specialOnly, '<tr class="row') >= 1);
  assert.equal(count(specialOnly, '未中'), 0, '仅看命中特码不应出现未中');
  ctx.call('switchView("pick3")');
  const pick3Only = ctx.get('historyBody').innerHTML;
  assert.equal(count(pick3Only, '>0 组<'), 0, '仅看有奖期不应出现 0 组');
  ctx.call('onlyHit = false; query = "9999-999"; renderHistory()');
  assert.match(ctx.get('historyBody').innerHTML, /暂无符合条件的记录/);
});

test('一键复制 7 码格式不变', async () => {
  const ctx = setup(remoteWithNext);
  await flush();
  await ctx.get('copyBtn').events.click();
  assert.match(ctx.clipboard[0], /^三中三 2026-327期 · 7码复式（35组）：\d{2}、\d{2}、\d{2}、\d{2}、\d{2}、\d{2}、\d{2}$/);
  assert.equal(ctx.get('copyBtn').textContent, '✅ 已复制');
});

test('手动补录开奖：校验、写入本机、刷新页面数据，并可撤销', async () => {
  const ctx = setup(snapshot);
  await flush();
  const setNums = (nums, label) => {
    if (label !== undefined) ctx.get('manualLabel').value = label;
    for (let i = 1; i <= 7; i++) ctx.get('manualNum' + i).value = String(nums[i - 1]);
  };
  assert.equal(ctx.get('manualBalls').innerHTML.split('manual-cell').length - 1, 7);
  assert.match(ctx.get('manualBalls').innerHTML, /第7位特码/);
  assert.equal(ctx.get('manualLabel').value, '2026-327');
  assert.equal(ctx.get('manualDate').value, '2026-11-23');
  assert.equal(ctx.get('manualCount').textContent, '手动记录 0 条');
  assert.equal(ctx.get('manualUndo').disabled, true);

  // 期号不连续
  setNums([3, 11, 22, 35, 41, 48, 7], '2026-329');
  await ctx.get('manualSubmit').events.click();
  assert.match(ctx.get('manualFlash').innerHTML, /必须紧接最新一期 2026-326/);
  assert.equal(ctx.get('latestIssue').textContent, '2026-326');
  assert.equal(ctx.store.has('three_in_three_sync_v1'), false);
  // 7 个号码重复
  setNums([3, 11, 22, 35, 41, 48, 48], '2026-327');
  await ctx.get('manualSubmit').events.click();
  assert.match(ctx.get('manualFlash').innerHTML, /互不重复/);
  // 特码越界
  setNums([3, 11, 22, 35, 41, 48, 50], '2026-327');
  await ctx.get('manualSubmit').events.click();
  assert.match(ctx.get('manualFlash').innerHTML, /第 7 位号码无效/);
  // 正常写入
  setNums([3, 11, 22, 35, 41, 48, 7], '2026-327');
  await ctx.get('manualSubmit').events.click();
  assert.match(ctx.get('manualFlash').innerHTML, /已保存 2026-327（2026-11-23）：正码 03、11、22、35、41、48 · 特码 07/);
  assert.equal(ctx.get('latestIssue').textContent, '2026-327');
  assert.equal(ctx.get('latestDate').textContent, '2026-11-23');
  assert.match(ctx.get('latestMeta').textContent, /第 7 位特码 07/);
  assert.equal(ctx.get('targetIssue').textContent, '2026-328');
  assert.equal(ctx.get('totalCount').textContent, 1787);
  assert.equal(ctx.get('manualCount').textContent, '手动记录 1 条');
  assert.equal(ctx.get('manualUndo').disabled, false);
  assert.equal(ctx.get('manualLabel').value, '2026-328', '保存后应预填下一期期号');
  assert.equal(ctx.get('manualNum1').value, '', '保存后应清空号码输入');
  assert.match(ctx.get('specialList').innerHTML, /2026-327[\s\S]{0,200}?ball red sm">07</);
  const saved = JSON.parse(ctx.store.get('three_in_three_sync_v1'));
  assert.equal(saved.schema, 2);
  assert.equal(saved.latestId, '2026-327');
  assert.deepEqual(saved.draws.at(-1).numbers, [3, 11, 22, 35, 41, 48]);
  assert.equal(saved.draws.at(-1).special, 7);
  assert.equal(saved.draws.at(-1).manual, true);
  assert.deepEqual(saved.invalid, ['2022-132']);
  assert.match(ctx.get('syncStatus').textContent, /本机手动补录 1 条，最新 2026-327/);
  // 撤销
  await ctx.get('manualUndo').events.click();
  assert.match(ctx.get('manualFlash').innerHTML, /已撤销手动记录 2026-327（特码 07）/);
  assert.equal(ctx.get('latestIssue').textContent, '2026-326');
  assert.equal(ctx.get('manualCount').textContent, '手动记录 0 条');
  assert.equal(ctx.get('manualUndo').disabled, true);
  assert.equal(JSON.parse(ctx.store.get('three_in_three_sync_v1')).latestId, '2026-326');
});

test('粘贴 7 个号码自动填入，第 7 位落到特码格', async () => {
  const ctx = setup(snapshot);
  await flush();
  ctx.get('manualPaste').value = '09 16 22 36 05 47 + 23';
  ctx.get('manualPaste').events.input({ target: ctx.get('manualPaste') });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(i => ctx.get('manualNum' + i).value), ['09', '16', '22', '36', '05', '47', '23']);
  assert.equal(ctx.get('manualPaste').value, '');
  assert.match(ctx.get('manualFlash').innerHTML, /特码 23/);
  // 不足 7 个不填入
  ctx.get('manualPaste').value = '19 04 14';
  ctx.get('manualPaste').events.input({ target: ctx.get('manualPaste') });
  assert.equal(ctx.get('manualNum1').value, '09', '不足 7 个时保留已填内容');
  // 期号变化时联动推算日期
  ctx.get('manualLabel').value = '2026-330';
  ctx.get('manualLabel').events.input({ target: ctx.get('manualLabel') });
  assert.equal(ctx.get('manualDate').value, '2026-11-26');
  ctx.get('manualLabel').value = '2026-999';
  ctx.get('manualLabel').events.input({ target: ctx.get('manualLabel') });
  assert.equal(ctx.get('manualDate').value, '');
  assert.equal(ctx.get('manualDate').placeholder, '期号格式无效');
  // 清空输入
  ctx.get('manualClear').events.click();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(i => ctx.get('manualNum' + i).value), ['', '', '', '', '', '', '']);
  assert.equal(ctx.get('manualLabel').value, '2026-327');
});

test('一键同步：新增期次并带特码，本机旧数据缺失特码时自动回填', async () => {
  const ctx = setup(remoteWithNext);
  await flush();
  await ctx.get('syncBtn').events.click();
  assert.equal(ctx.get('latestIssue').textContent, '2026-327');
  assert.match(ctx.get('latestMeta').textContent, /第 7 位特码 07/);
  assert.equal(ctx.get('targetIssue').textContent, '2026-328');
  assert.match(ctx.get('syncStatus').textContent, /新增 1 期/);
  assert.match(ctx.get('syncStatus').textContent, /特码 07/);
  assert.equal(ctx.get('syncBtn').disabled, false);
  const saved = JSON.parse(ctx.store.get('three_in_three_sync_v1'));
  assert.equal(saved.draws.at(-1).numbers.length, 6);
  assert.equal(saved.draws.at(-1).special, 7);
  assert.equal(saved.draws.at(-1).manual, undefined);
});

test('同步冲突或缺口时不修改本机数据、推荐与特码记录', async () => {
  const conflict = { ...snapshot, draws: snapshot.draws.map(d => (d.id === '2026-326' ? { ...d, numbers: [1, 2, 3, 4, 5, 6] } : d)) };
  const ctx = setup(conflict);
  await flush();
  const before = ctx.get('specialList').innerHTML;
  await ctx.get('syncBtn').events.click();
  assert.match(ctx.get('syncStatus').textContent, /冲突/);
  assert.equal(ctx.get('latestIssue').textContent, '2026-326');
  // 失败时只记「上次同步 失败」这类元信息，绝不写入新期次（不要整体 diff 存储对象）
  const saved = JSON.parse(ctx.store.get('three_in_three_sync_v1'));
  assert.equal(saved.latestId, '2026-326');
  assert.equal(saved.draws.length, 1786, '无效期 2022-132 不入库，且冲突数据未写入');
  assert.equal(saved.lastSync.text, '失败');
  assert.equal(ctx.get('specialList').innerHTML, before);
  // 特码冲突同样不写入
  const specialConflict = { ...snapshot, draws: snapshot.draws.map(d => (d.id === '2026-326' ? { ...d, special: 1 } : d)) };
  const ctx2 = setup(specialConflict);
  await flush();
  await ctx2.get('syncBtn').events.click();
  assert.match(ctx2.get('syncStatus').textContent, /特码冲突/);
  assert.equal(ctx2.get('latestIssue').textContent, '2026-326');
  const saved2 = JSON.parse(ctx2.store.get('three_in_three_sync_v1'));
  assert.equal(saved2.latestId, '2026-326');
  assert.equal(saved2.draws.at(-1).special, 23, '本机特码不被冲突来源覆盖');
  assert.equal(saved2.lastSync.text, '失败');
  // 期号缺口
  const gap = { ...snapshot, latestId: '2026-328', draws: [{ ...NEXT, id: '2026-328', periodNum: 328 }, ...snapshot.draws] };
  const ctx3 = setup(gap);
  await flush();
  await ctx3.get('syncBtn').events.click();
  assert.match(ctx3.get('syncStatus').textContent, /缺口/);
  assert.equal(ctx3.get('latestIssue').textContent, '2026-326');
  assert.equal(JSON.parse(ctx3.store.get('three_in_three_sync_v1')).latestId, '2026-326');
});

test('特码缺失的旧数据仍可正常使用，并由同步回填特码', async () => {
  // 模拟改版前的状态：内置快照与本机备份都只有前 6 码，没有特码字段
  const legacyDraws = snapshot.draws.map(({ id, date, numbers }) => ({ id, date, numbers }));
  const legacyBuiltin = { ...snapshot, draws: legacyDraws };
  const ctx = setup(snapshot, legacyBuiltin);
  ctx.store.set('three_in_three_sync_v1', JSON.stringify({ updatedAt: snapshot.updatedAt, latestId: '2026-326', draws: legacyDraws, invalid: ['2022-132'] }));
  await flush();
  assert.equal(ctx.get('latestIssue').textContent, '2026-326');
  assert.match(ctx.get('syncStatus').textContent, /该期特码未记录/);
  assert.match(ctx.get('latestBalls').innerHTML, /ball ghost lg">--</);
  assert.equal(ctx.get('specialList').innerHTML.includes('ball sm ghost'), true);
  // 同步上游（含特码）→ 回填特码，不改动平码
  await ctx.get('syncBtn').events.click();
  assert.match(ctx.get('syncStatus').textContent, /回填特码 1786 期/);
  assert.match(ctx.get('latestMeta').textContent, /第 7 位特码 23/);
  assert.equal(ctx.get('latestIssue').textContent, '2026-326');
  assert.equal(JSON.parse(ctx.store.get('three_in_three_sync_v1')).draws.at(-1).special, 23);
});

test('本机数据损坏或落后于内置快照时回退内置数据，不影响使用', async () => {
  const ctx = setup(snapshot);
  ctx.store.set('three_in_three_sync_v1', '{坏掉的 JSON');
  await flush();
  assert.equal(ctx.get('latestIssue').textContent, '2026-326');
  assert.match(ctx.get('syncStatus').textContent, /本机同步数据无效或有冲突，已使用内置数据/);
  const ctx2 = setup(snapshot);
  ctx2.store.set('three_in_three_sync_v1', JSON.stringify({ updatedAt: '', latestId: '2026-300', draws: [{ id: '2026-300', date: '2026-10-27', numbers: [1, 29, 23, 17, 18, 42], special: 5 }] }));
  await flush();
  assert.equal(ctx2.get('latestIssue').textContent, '2026-326', '内置快照更新时应采用内置数据');
  assert.match(ctx2.get('syncStatus').textContent, /落后于当前记录/);
});

test('同步辅助：期数差、时间格式与状态条四格内容', async () => {
  const ctx = setup(snapshot);
  await flush();
  // 期数差：同期为 0、逐期累加、跨年、倒退与空值都给出确定结果
  assert.equal(ctx.call("countPeriodsBetween('2026-326','2026-326')"), 0);
  assert.equal(ctx.call("countPeriodsBetween('2026-326','2026-328')"), 2);
  assert.equal(ctx.call("countPeriodsBetween('2025-365','2026-002')"), 2, '跨年也应逐期推算');
  assert.equal(ctx.call("countPeriodsBetween('2026-328','2026-326')"), null, '倒退返回 null');
  assert.equal(ctx.call("countPeriodsBetween('','2026-326')"), null);
  // 时间统一按 UTC 展示，坏值不抛错
  assert.equal(ctx.call("fmtStamp('2026-11-22T22:07:15.558Z')"), '2026-11-22 22:07 UTC');
  assert.equal(ctx.call("fmtStamp('')"), '未知时间');
  assert.equal(ctx.call("fmtStamp('不是时间')"), '不是时间');
  // 未检查上游时，状态条不假装知道上游状态
  const strip = ctx.get('syncStrip');
  assert.equal(count(strip.innerHTML, 'stat-cell'), 4);
  assert.match(strip.innerHTML, /本机最新期[\s\S]{0,120}?2026-326[\s\S]{0,80}?2026-11-22 · 特码 23/);
  assert.match(strip.innerHTML, /内置快照[\s\S]{0,120}?2026-326[\s\S]{0,80}?更新于 2026-11-22 22:07 UTC/);
  assert.match(strip.innerHTML, /上游最新期[\s\S]{0,80}?未检查[\s\S]{0,120}?点「检查更新」或「一键同步」/);
  assert.match(strip.innerHTML, /上次同步[\s\S]{0,80}?尚未同步[\s\S]{0,120}?本机数据来自内置快照/);
  assert.ok(!strip.innerHTML.includes('alert'), '无待同步期次时不用告警配色');
  // 上游更新后：第三格转告警色，提示 pill 与高亮按钮由 setSyncHint 控制
  ctx.call("upstream = { label: '2026-328', updatedAt: '2026-11-24T22:00:00.000Z' }; renderSyncStrip(); setSyncHint('上游有 2 期可同步');");
  assert.match(ctx.get('syncStrip').innerHTML, /stat-cell alert/);
  assert.match(ctx.get('syncStrip').innerHTML, /上游最新期[\s\S]{0,80}?2026-328/);
  assert.equal(ctx.get('syncHint').textContent, '上游有 2 期可同步');
  assert.equal(ctx.get('syncHint').hidden, false);
  assert.equal(ctx.get('syncBtn').className, 'btn primary attention');
  ctx.call("setSyncHint('')");
  assert.equal(ctx.get('syncHint').hidden, true);
  assert.equal(ctx.get('syncBtn').className, 'btn primary');
  // 本机超前上游时，第四格改标题，不再显示「上次同步」
  ctx.call("lastSync = { at: '2026-11-24T10:00:00.000Z', text: '新增 1 期' }; upstream = { label: '2026-326', updatedAt: '' }; records.push({ year: 2026, periodNum: 327, label: '2026-327', date: '2026-11-23', numbers: [3, 11, 22, 35, 41, 48], special: 7, manual: true }); renderSyncStrip();");
  const ahead = ctx.get('syncStrip').innerHTML;
  assert.match(ahead, /本机已超前上游[\s\S]{0,80}?新增 1 期/);
  assert.match(ahead, /2026-11-24 10:00 UTC/);
  assert.ok(!ahead.includes('stat-cell alert'), '本机超前不是待同步状态');
});
