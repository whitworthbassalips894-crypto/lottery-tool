'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers.cjs');

const allocation = { 10: [3,1,1], 20: [6,3,1], 30: [9,5,1], 40: [12,6,2], 50: [15,8,2] };

test('底库和五档方案：注数、号码、成本、确定性和子集关系', () => {
  const { T } = loadPage();
  const { draws, codes } = T.allData();
  assert.equal(draws.length, 2103);
  assert.equal(codes.at(-1), '2026282');
  assert.equal(T.expectedCode(), '2026283');
  for (const code of ['2026283', '2027001', '2024200']) {
    let previous = new Set();
    for (const budget of [10,20,30,40,50]) {
      const tickets = T.generateRecommendedPlan(code, budget);
      assert.equal(tickets.length, budget / 2);
      assert.deepEqual([4,5,10].map(k => tickets.filter(t => t.pickK === k).length), allocation[budget]);
      const seen = new Set();
      for (const t of tickets) {
        assert.equal(t.nums.length, t.pickK);
        assert.equal(new Set(t.nums).size, t.pickK);
        assert.ok(t.nums.every((n,i) => Number.isInteger(n) && n >= 1 && n <= 80 && (!i || t.nums[i-1] < n)));
        const sig = t.pickK + ':' + t.nums.join(',');
        assert.ok(!seen.has(sig));
        seen.add(sig);
      }
      for (const sig of previous) assert.ok(seen.has(sig), '较低预算应为子集');
      previous = seen;
      assert.equal(JSON.stringify(T.generateRecommendedPlan(code, budget)), JSON.stringify(tickets));
    }
  }
  assert.throws(() => T.generateRecommendedPlan('2026283', 15), /无效预算/);
  // 沿用旧版10元号码，避免已复制投注与新版本历史回放不一致。
  assert.equal(JSON.stringify(T.generateRecommendedPlan('2026283', 10)), JSON.stringify([
    {pickK:4,nums:[11,14,25,56]}, {pickK:4,nums:[4,10,64,71]},
    {pickK:4,nums:[28,41,62,77]}, {pickK:5,nums:[7,29,33,44,69]},
    {pickK:10,nums:[3,7,15,17,43,48,50,51,61,80]}
  ]));
});

test('五档历史回放：号码、逐注玩法、奖金、成本、追加未来数据一致', () => {
  const { T } = loadPage();
  const all = T.allData();
  const draws = all.draws.slice(-4), codes = all.codes.slice(-4), dates = all.dates.slice(-4);
  for (const budget of [10,20,30,40,50]) {
    const archive = T.buildArchive(draws, codes, dates, budget);
    const rows = archive.byYear['2026'];
    assert.equal(rows.length, 4);
    assert.equal(archive.statsByScope['2026'].totalCost, 4 * budget);
    assert.equal(archive.statsByScope.recent100.totalCost, 4 * budget);
    assert.equal(archive.statsByScope['2026'].perStrat.length, budget / 2);
    let total = 0;
    for (const row of rows) {
      const expected = T.generateRecommendedPlan(row.code, budget);
      assert.equal(row.evals.length, budget / 2);
      for (let i = 0; i < expected.length; i++) {
        const ev = row.evals[i], ticket = expected[i];
        assert.equal(ev.pickK, ticket.pickK);
        assert.equal(ev.nums.join(','), ticket.nums.join(','));
        const hits = ticket.nums.filter(n => row.actual.includes(n)).length;
        const prize = T.evalPrize(ticket.pickK, hits);
        assert.equal(ev.hits, hits);
        assert.equal(ev.win, prize.win);
        assert.equal(ev.amount, prize.amount);
        assert.equal(ev.zero, prize.zero);
      }
      assert.equal(row.periodPrize, row.evals.reduce((s, e) => s + e.amount, 0));
      total += row.periodPrize;
    }
    assert.equal(archive.statsByScope['2026'].totalPrize, total);
    const past = T.buildArchive(draws.slice(0, 2), codes.slice(0, 2), dates.slice(0, 2), budget);
    assert.equal(JSON.stringify(past.byYear['2026'][0].evals), JSON.stringify(rows[0].evals));
  }
});

test('切换方案同步回放、复制文本及预算持久化', () => {
  const { T, document, localStorage } = loadPage();
  for (const budget of [10,30,40,50,20]) {
    document.getElementById('budget' + budget).click();
    assert.equal(T.lastRecommended.budget, budget);
    assert.equal(T.lastRecommended.tickets.length, budget / 2);
    assert.match(document.getElementById('recommendedSummary').textContent, new RegExp(`共 ${budget} 元`));
    assert.match(document.getElementById('metrics').innerHTML, new RegExp(`${budget}元方案`));
    const text = T.formatRecommendedText(T.lastRecommended);
    assert.match(text, new RegExp(`2026283期 · 单倍 ${budget}元`));
    assert.equal(text.split('\n').length, budget / 2 + 1);
    assert.ok(text.includes('选四：') && text.includes('选五：') && text.includes('选十：'));
    assert.equal(localStorage.getItem('kl8_recommended_budget_v1'), String(budget));
  }
  document.getElementById('budget30').click();
  const restored = loadPage({preStorage: localStorage._dump()});
  assert.equal(restored.T.lastRecommended.budget, 30);
  assert.equal(restored.T.formatRecommendedText(restored.T.lastRecommended), T.formatRecommendedText(T.lastRecommended));
});

test('回放正确处理选十浮动头奖与全不中奖', () => {
  const { T } = loadPage();
  const code = '2026283';
  const dream = T.generateRecommendedPlan(code, 10).find(t => t.pickK === 10).nums;
  const extras = Array.from({length: 80}, (_, i) => i + 1).filter(n => !dream.includes(n));
  const allHit = dream.concat(extras.slice(0, 10));
  const allMiss = extras.slice(0, 20);
  const full = T.buildArchive([allHit], [code], ['2026-10-24'], 10).byYear['2026'][0];
  const zero = T.buildArchive([allMiss], [code], ['2026-10-24'], 10).byYear['2026'][0];
  const winning = full.evals.find(e => e.pickK === 10);
  assert.equal(winning.hits, 10);
  assert.equal(winning.floating, true);
  assert.equal(winning.amount, 5000000);
  assert.equal(full.hasFloating, true);
  const missed = zero.evals.find(e => e.pickK === 10);
  assert.equal(missed.hits, 0);
  assert.equal(missed.zero, true);
  assert.equal(missed.amount, 2);
});

test('复制按钮提供当前预算、期号、每注玩法和完整号码', async () => {
  const { T, document, sandbox } = loadPage();
  let copied = '';
  sandbox.navigator.clipboard = { writeText: async text => { copied = text; } };
  document.getElementById('budget50').click();
  document.getElementById('copyRecommended').click();
  await Promise.resolve();
  assert.equal(copied, T.formatRecommendedText(T.lastRecommended));
  assert.equal(copied.split('\n').length, 26);
  assert.match(copied, /单倍 50元（25注）/);
});
