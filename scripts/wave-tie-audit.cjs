#!/usr/bin/env node
'use strict';
/**
 * 波色并列 bug 审计（只读）：对比「修复前（reduce 并列取后键）」与「修复后（pickPredWave）」。
 *
 * 用法：node scripts/wave-tie-audit.cjs [数据末期，默认取 am-latest.json 最新一期]
 *
 * 做法：从 index.html 取出 simulateEngine / longWaveEngine 的源码，把 predWave 那一行换回旧实现，
 * 在同一个 VM 里与当前实现逐期对比；不另写预测算法、不修改任何仓库文件。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require(path.resolve(__dirname, '..', 'tests', 'helpers.cjs'));

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
function grab(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('找不到 ' + name);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  return html.slice(start, i);
}

const latest = JSON.parse(fs.readFileSync(H.DATA_PATH, 'utf8')).latestLabel;
const page = H.loadPage({ preStorage: H.extraStorage(latest) });
const sb = page.sandbox;
const { draws, labels } = sb.allData();

const currentCall = 'const predWave=pickPredWave(waveCounts);';
const simSrc = grab('simulateEngine');
if (!simSrc.includes(currentCall)) throw new Error('当前 simulateEngine 未使用 pickPredWave，无法对比');
const oldSim = simSrc.replace(currentCall, 'const predWave=Object.keys(waveCounts).reduce((a,b)=>waveCounts[a]<waveCounts[b]?a:b);');
vm.runInContext(oldSim.replace('function simulateEngine(', 'function simulateEngineOld('), sb);
vm.runInContext(
  grab('longWaveEngine').replace('function longWaveEngine(', 'function longWaveEngineOld(').replace('simulateEngine(hist)', 'simulateEngineOld(hist)'),
  sb
);

let changed = 0, flips = 0, hitsOld = 0, hitsNew = 0;
const rows = [];
for (let i = 60; i < draws.length; i++) {
  const label = labels[i], hist = draws.slice(0, i), actual = draws[i][6];
  const o = sb.longWaveEngineOld(hist, label).mergeNums;
  const n = sb.longWaveEngine(hist, label).mergeNums;
  const ho = o.includes(actual), hn = n.includes(actual);
  hitsOld += ho ? 1 : 0; hitsNew += hn ? 1 : 0;
  if (o.join(',') !== n.join(',')) changed++;
  if (ho !== hn) flips++;
  rows.push({ label, ho, hn });
}
const N = rows.length;
const windowRows = rows.filter(r => r.label >= '2026-201');
const last58 = rows.filter(r => r.label >= '2026-201' && r.label <= '2026-258');
const y2026 = rows.filter(r => r.label.startsWith('2026') && r.label <= '2026-258');

console.log(`数据：${latest} · 回放 ${N} 期（${rows[0].label} ~ ${rows[N - 1].label}）`);
console.log(`7 码集合改变：${changed} 期（${(changed / N * 100).toFixed(2)}%）`);
console.log(`命中判定翻转：${flips} 期`);
console.log(`全历史命中：修复前 ${hitsOld} → 修复后 ${hitsNew}`);
console.log(`2026-201~${latest}：修复前 ${windowRows.filter(r => r.ho).length}/${windowRows.length} → 修复后 ${windowRows.filter(r => r.hn).length}/${windowRows.length}`);
console.log(`2026-201~2026-258：修复前 ${last58.filter(r => r.ho).length}/58 → 修复后 ${last58.filter(r => r.hn).length}/58`);
console.log(`2026-001~2026-258：修复前 ${y2026.filter(r => r.ho).length} → 修复后 ${y2026.filter(r => r.hn).length}`);

// 波色选中分布
const red = [1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46];
const blue = [3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48];
const wv = n => red.includes(n) ? 'red' : blue.includes(n) ? 'blue' : 'green';
const T = sb.window.__LOTTO_SYNC_TEST__;
const cntOld = { red: 0, blue: 0, green: 0 }, cntNew = { red: 0, blue: 0, green: 0 };
for (let i = 60; i < draws.length; i++) {
  const c = { red: 0, blue: 0, green: 0 };
  for (let j = i - 45; j < i; j++) c[wv(draws[j][6])]++;
  const keys = Object.keys(c);
  cntOld[keys.reduce((a, b) => c[a] < c[b] ? a : b)]++;
  cntNew[T.pickPredWave(c)]++;
}
const pct = o => `${(o.red / N * 100).toFixed(1)}% / ${(o.blue / N * 100).toFixed(1)}% / ${(o.green / N * 100).toFixed(1)}%`;
console.log(`选中波色（红/蓝/绿）：修复前 ${pct(cntOld)} → 修复后 ${pct(cntNew)}（红组号码占比 ${(17 / 49 * 100).toFixed(1)}%）`);
