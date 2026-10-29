'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers.cjs');

test('底库加载：包含 2103 期快乐8真实历史记录，默认玩法为选十', () => {
  const { T } = loadPage();
  const { draws, codes, dates } = T.allData();
  assert.equal(draws.length, 2103);
  assert.equal(codes[0], '2020001');
  assert.equal(dates[0], '2020-10-28');
  assert.equal(codes[codes.length - 1], '2026282');
  assert.equal(dates[dates.length - 1], '2026-10-23');
  assert.equal(T.expectedCode(), '2026283');
  assert.equal(T.currentPick, 10, '默认应为选十玩法');

  // 抽查首尾期号码合法性：20 个升序不重复 1..80 整数
  for (const d of [draws[0], draws[1000], draws[draws.length - 1]]) {
    assert.equal(T.validateNums(d), true);
    for (let i = 1; i < d.length; i++) assert.ok(d[i] > d[i - 1], '号码应升序排列');
  }
});

test('预热边界：少于 60 期返回 null，满 60 期正常产出 10 注', () => {
  const { T } = loadPage();
  const { draws } = T.allData();
  assert.equal(T.generateDailyTickets(draws.slice(0, 59), '2020060', 10), null);
  const res60 = T.generateDailyTickets(draws.slice(0, 60), '2020061', 10);
  assert.ok(res60 && Array.isArray(res60.tickets));
  assert.equal(res60.tickets.length, 10);
});

test('选一至选十全玩法切换：每期稳定生成 10 注（1注随机＋4注策略＋5注覆盖），号码合法且互不完全雷同', () => {
  const { T } = loadPage();
  const { draws } = T.allData();
  const target = T.expectedCode();

  for (let k = 1; k <= 10; k++) {
    T.setPickMode(k);
    assert.equal(T.currentPick, k);
    const res = T.generateDailyTickets(draws, target, k, 0);
    assert.equal(res.tickets.length, 10, `选${k}应产出 10 注`);

    for (let ti = 0; ti < 10; ti++) {
      const tk = res.tickets[ti];
      assert.equal(tk.length, k, `选${k} 第${ti + 1}注长度应为 ${k}`);
      assert.equal(new Set(tk).size, k, `选${k} 第${ti + 1}注内部不应有重复号码`);
      for (let m = 0; m < tk.length; m++) {
        assert.ok(Number.isInteger(tk[m]) && tk[m] >= 1 && tk[m] <= 80, '号码须在 1..80 之间');
        if (m > 0) assert.ok(tk[m] > tk[m - 1], '号码须升序排列');
      }
    }

    if (k >= 5) {
      // 至少 4 种以上互不相同的组合，防止策略退化成同一注
      const sigs = new Set(res.tickets.map(tk => tk.join(',')));
      assert.equal(sigs.size, 10, `选${k} 的 10 注应当各不相同`);

      // 第 5 注（四区均衡）应满足四区配额均衡：每区不超过 ceil(k/4)
      const t5 = res.tickets[4];
      const qCnt = [0, 0, 0, 0];
      for (const n of t5) qCnt[n <= 20 ? 0 : n <= 40 ? 1 : n <= 60 ? 2 : 3]++;
      const maxQ = Math.ceil(k / 4);
      const minQ = Math.floor(k / 4);
      for (let q = 0; q < 4; q++) {
        assert.ok(qCnt[q] >= minQ && qCnt[q] <= maxQ, `选${k} 第5注四区分布不均衡: ${qCnt}`);
      }
    }
  }
});

test('第 1 注随机机选：定种可复现、支持手动重摇换号与恢复默认', () => {
  const { T } = loadPage();
  const base5 = Array.from(T.lastDailyRender.tickets, t => t.join(','));

  // 重新加载页面，默认随机注和其余 9 注完全一致
  const { T: T2 } = loadPage();
  const again5 = Array.from(T2.lastDailyRender.tickets, t => t.join(','));
  assert.deepEqual(again5, base5);

  // 手动重摇第 1 注：第 1 注变化，第 2~10 注策略保持不变
  T.rerollRandomTicket();
  assert.equal(T.rerollNonce, 1);
  const rerolled = Array.from(T.lastDailyRender.tickets, t => t.join(','));
  assert.notEqual(rerolled[0], base5[0], '重摇后第 1 注随机号应更新');
  assert.deepEqual(rerolled.slice(1), base5.slice(1), '重摇第 1 注不应改变第 2~10 注策略选号');

  // 恢复默认随机注
  T.resetRandomTicket();
  assert.equal(T.rerollNonce, 0);
  assert.equal(T.lastDailyRender.tickets[0].join(','), base5[0]);
});

test('严格无未来信息 & 增量回放等价性：buildArchive 与单期独立切片预测 100% 一致，追加新期不改变历史预测', () => {
  const { T } = loadPage();
  const { draws, codes, dates } = T.allData();
  const archive = T.buildArchive(draws, codes, dates, 10);
  const rows2026 = archive.byYear['2026'];
  assert.equal(rows2026.length, 282);
  assert.equal(archive.statsByScope['2026'].totalCost, 282 * 20);
  assert.equal(archive.statsByScope['2026'].perStrat.length, 10);
  assert.equal(rows2026[0].evals.length, 10);
  assert.equal(rows2026[0].periodPrize, rows2026[0].evals.reduce((sum, e) => sum + e.amount, 0));

  // 抽查若干历史期次：增量状态回放结果与只传入 draws.slice(0, i) 独立计算逐注逐码完全相同
  for (const checkCode of ['2020061', '2022100', '2024200', '2026001', '2026282']) {
    const idx = codes.indexOf(checkCode);
    assert.ok(idx >= 60);
    const standalone = T.generateDailyTickets(draws.slice(0, idx), checkCode, 10, 0).tickets;
    const year = checkCode.slice(0, 4);
    const archivedItem = archive.byYear[year].find(r => r.code === checkCode);
    assert.ok(archivedItem, `应在回放中找到 ${checkCode}`);
    const archivedTickets = archivedItem.evals.map(e => e.nums);
    assert.deepEqual(archivedTickets, standalone, `期号 ${checkCode} 的增量回放与独立切片计算不一致`);
  }

  // 追加未来新期（2026283、2026284），验证此前 2026282 的 10 注预测毫发无损
  const before282 = archive.byYear['2026'].find(r => r.code === '2026282').evals.map(e => e.nums.join(','));
  const plan = T.planAppend([
    { code: '2026283', year: 2026, period: 283, date: '2026-10-24', nums: [1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31,33,35,37,39] },
    { code: '2026284', year: 2026, period: 284, date: '2026-10-25', nums: [2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40] }
  ]);
  const res = T.applyPlan(plan);
  assert.equal(res.ok, true);
  assert.equal(res.wrote, 2);

  const afterData = T.allData();
  const afterArchive = T.buildArchive(afterData.draws, afterData.codes, afterData.dates, 10);
  const after282 = afterArchive.byYear['2026'].find(r => r.code === '2026282').evals.map(e => e.nums.join(','));
  assert.deepEqual(after282, before282, '追加未来开奖数据绝不能改变早期期次的 10 注预测');
});
