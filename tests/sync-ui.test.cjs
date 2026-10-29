'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers.cjs');
const syncScript = require('../scripts/sync-kl8.js');

test('页面模块核验：已彻底移除「号码热度」「6. 前瞻验证」「自动降档省钱助手」及旧六合彩残留', () => {
  const { html, document } = loadPage();

  // 确认已删除的模块与旧概念不存在
  for (const forbidden of [
    '号码热度',
    'id="heatmap"',
    'renderHeat',
    '前瞻验证',
    'id="fwdStart"',
    'id="fwdBody"',
    'id="mcPanel"',
    'binomRightTail',
    '自动降档省钱助手',
    'id="smPanel"',
    'am-latest.json',
    '六合彩',
    '特码'
  ]) {
    assert.equal(html.includes(forbidden), false, `index.html 不应残留 "${forbidden}"`);
  }

  // 确认保留的四大核心模块均在页面且已正常渲染
  for (const required of [
    '1. 每日 10 注选号',
    '2. 录入开奖',
    '3. 历史回放',
    '4. 数据同步',
    './data/kl8-latest.json'
  ]) {
    assert.equal(html.includes(required), true, `index.html 应包含 "${required}"`);
  }

  assert.equal(document.getElementById('totalCount').textContent, 2103);
  assert.equal(document.getElementById('latestIssue').textContent, '2026282');
  assert.equal(document.getElementById('targetIssue').textContent, '2026283');
  assert.ok(document.getElementById('ticketsGrid').innerHTML.includes('随机机选'));
  assert.ok(document.getElementById('ticketsGrid').innerHTML.includes('热势恒强'));
  assert.ok(document.getElementById('ticketsGrid').innerHTML.includes('遗漏回补'));
  assert.ok(document.getElementById('ticketsGrid').innerHTML.includes('关联共振'));
  assert.ok(document.getElementById('ticketsGrid').innerHTML.includes('四区均衡'));
});

test('多格式解析器：同时兼容福彩官网 JSON、Markdown、纯文本与 HTML（前端与同步脚本一致）', () => {
  const { T } = loadPage();

  // 1) 福彩官网 findDrawNotice JSON 格式
  const cwlSample = JSON.stringify({
    state: 0,
    result: [
      {
        code: '2026283',
        date: '2026-10-24(六)',
        red: '02,05,09,11,14,18,22,27,31,36,41,44,49,53,58,62,67,71,76,80'
      }
    ]
  });
  for (const parser of [syncScript.parseDrawText, T.parseDrawText]) {
    const p1 = parser(cwlSample);
    assert.equal(p1.records.length, 1);
    assert.equal(p1.records[0].code, '2026283');
    assert.equal(p1.records[0].date, '2026-10-24');
    assert.equal(p1.records[0].nums.length, 20);
    assert.equal(p1.records[0].nums[0], 2);
    assert.equal(p1.records[0].nums[19], 80);
  }

  // 2) Markdown / 纯文本多期混合格式
  const mdSample = `
- **2026284（2026/10/25）**：01 04 07 10 13 16 19 22 25 28 31 34 37 40 43 46 49 52 55 58
第 2026-283 期 开奖时间：2026-10-24 销售额：123,456,789元
80 76 71 67 62 58 53 49 44 41 36 31 27 22 18 14 11 09 05 02
  `;
  for (const parser of [syncScript.parseDrawText, T.parseDrawText]) {
    const p2 = parser(mdSample);
    assert.equal(p2.records.length, 2);
    const byCode = Object.fromEntries(p2.records.map(r => [r.code, r]));
    assert.ok(byCode['2026283']);
    assert.ok(byCode['2026284']);
    assert.equal(byCode['2026283'].nums[0], 2, '乱序输入应自动规范化为升序');
    assert.equal(byCode['2026283'].nums[19], 80);
  }
});

test('数据同步保护：连续追加、跨年首期衔接、期号断档拦截与冲突保留', () => {
  const { T } = loadPage();

  // 1) 期号缺口拦截（本地最新 2026282，直接给 2026284 应识别出缺 2026283）
  const gapPlan = T.planAppend([
    { code: '2026284', year: 2026, period: 284, date: '2026-10-25', nums: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20] }
  ]);
  assert.equal(gapPlan.append.length, 0);
  assert.equal(gapPlan.gapFrom, '2026283');

  // 2) 同号冲突检测（2026282 与内置号码不同应记录冲突且保留本地值）
  const conflictPlan = T.planAppend([
    { code: '2026282', year: 2026, period: 282, date: '2026-10-23', nums: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20] },
    { code: '2026283', year: 2026, period: 283, date: '2026-10-24', nums: [2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40] }
  ]);
  assert.equal(conflictPlan.conflicts.length, 1);
  assert.equal(conflictPlan.conflictCodes[0], '2026282');
  assert.equal(conflictPlan.append.length, 1);
  assert.equal(conflictPlan.append[0].code, '2026283');

  // 3) 跨年衔接规则（快乐8年末休市后 2026351 → 2027001 应判定连续）
  assert.equal(T.isNextConsecutiveCode('2026351', '2027001'), true);
  assert.equal(T.isNextConsecutiveCode('2026282', '2027001'), false, '10月期号不能直接跨年跳到次年001');
});

test('北京时间开奖边界与数据新鲜度：缺失、延迟、休市和今日数据不混淆', () => {
  const { T } = loadPage();
  const before = new Date('2026-10-29T13:29:59Z');
  const after = new Date('2026-10-29T13:30:00Z');
  assert.match(T.drawFreshness('2026-10-28', before).text, /尚未到/);
  const stale = T.drawFreshness('2026-10-28', after);
  assert.equal(stale.warn, true);
  assert.match(stale.text, /尚无今日开奖/);
  assert.match(stale.text, /休市/);
  assert.equal(T.drawFreshness('2026-10-29', after).warn, false);
  assert.match(T.drawFreshness('2026-10-29', after).text, /今日开奖/);
  assert.equal(T.drawFreshness('', after).warn, true);
  assert.equal(T.drawFreshness('2026-10-30', after).warn, true);
  // 北京时间跨日，不能依赖设备当地时区。
  assert.match(T.drawFreshness('2026-10-29', new Date('2026-10-29T16:00:00Z')).text, /尚未到/);
});

test('一键同步离线失败：明确提示，不把缓存或本地旧结果说成最新', async () => {
  const { T, document } = loadPage({ fetch: async () => { throw new Error('offline'); } });
  await T.syncNow();
  assert.match(document.getElementById('ssMsg').textContent, /无法读取/);
  assert.match(document.getElementById('syncLog').textContent, /读取失败/);
  assert.equal(document.getElementById('syncBtn').disabled, false);
});
