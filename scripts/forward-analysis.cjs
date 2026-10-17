#!/usr/bin/env node
'use strict';
/**
 * 前瞻样本分析（只读，不修改任何数据/页面文件）
 *
 * 用法：
 *   node scripts/forward-analysis.cjs                # 默认起算期 2026-201，数据用 data/am-latest.json 的最新一期
 *   node scripts/forward-analysis.cjs 2026-001       # 指定起算期
 *
 * 直接用 tests/helpers.cjs 在 Node VM 中执行 index.html 里的原始引擎，
 * 不另写一份预测算法；统计口径与页面「6. 前瞻验证」一致（无未来信息：第 i 期只用其之前的历史）。
 */
const fs = require('fs');
const path = require('path');
const H = require(path.resolve(__dirname, '..', 'tests', 'helpers.cjs'));

const start = process.argv[2] || '2026-201';

/** 精确二项尾概率（log 域计算，避免大组合数溢出；页面用的是 Kahan 累加版） */
const lnChoose = (n, k) => { let s = 0; for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1); return s; };
function binomTail(N, fromK, toK, pNum = 1, pDen = 7) {
  const lp = Math.log(pNum / pDen), lq = Math.log(1 - pNum / pDen);
  let max = -Infinity; const logs = [];
  for (let k = fromK; k <= toK; k++) {
    const L = lnChoose(N, k) + k * lp + (N - k) * lq;
    logs.push(L);
    if (L > max) max = L;
  }
  let s = 0;
  for (const L of logs) s += Math.exp(L - max);
  return Math.exp(max + Math.log(s));
}
/** 精确二项右尾 P[Binomial(N,p) >= K] */
const binomRightTail = (N, K, pNum = 1, pDen = 7) => (K <= 0 ? 1 : K > N ? 0 : binomTail(N, K, N, pNum, pDen));
/** 精确二项左尾 P[Binomial(N,p) <= K] */
const binomLeftTail = (N, K, pNum = 1, pDen = 7) => (K < 0 ? 0 : K >= N ? 1 : binomTail(N, 0, K, pNum, pDen));

function main() {
  const raw = JSON.parse(fs.readFileSync(H.DATA_PATH, 'utf8'));
  const latest = raw.latestLabel || raw.records[raw.records.length - 1].label;
  const page = H.loadPage({ preStorage: H.extraStorage(latest) });
  const T = H.hooks(page);
  const { draws, labels } = page.sandbox.allData();

  // 逐期历史回放（只喂该期之前的数据）
  const rows = [];
  const from = Math.max(labels.indexOf(start), 60);
  for (let i = from; i < draws.length; i++) {
    const m = page.sandbox.longWaveEngine(draws.slice(0, i), labels[i]);
    const actual = draws[i][6];
    rows.push({ label: labels[i], pred: m.mergeNums.slice(), actual, hit: m.mergeNums.includes(actual) });
  }

  const N = rows.length, K = rows.filter(r => r.hit).length;
  const p1 = 1 / 7;
  const pv = binomRightTail(N, K);
  const z = (K - N * p1 - 0.5) / Math.sqrt(N * p1 * (1 - p1));

  console.log(`数据：${raw.latestLabel}（updatedAt ${raw.updatedAt}） · 起算期 ${start}`);
  console.log(`样本： ${rows[0].label} ~ ${rows[rows.length - 1].label} · N=${N}`);
  console.log(`命中： ${K}/${N} = ${(K / N * 100).toFixed(2)}%  随机期望 ${(N * p1).toFixed(2)}  超额 ${(K - N * p1 >= 0 ? '+' : '')}${(K - N * p1).toFixed(2)}`);
  console.log(`检验： z(连续性修正) ${z >= 0 ? '+' : ''}${z.toFixed(2)}  精确右尾 p=${pv.toFixed(6)}  ${pv < 0.05 ? '显著' : pv < 0.10 ? '边缘/不显著' : '不显著'}`);

  console.log('\n每 10 期：');
  for (let a = 0; a < N; a += 10) {
    const seg = rows.slice(a, a + 10);
    const k = seg.filter(r => r.hit).length;
    console.log(`  ${seg[0].label}~${seg[seg.length - 1].label}: ${k}/${seg.length} = ${(k / seg.length * 100).toFixed(1)}%`);
  }

  console.log('\n最近窗口（尾部）命中率与显著性 —— 回答「最近是不是不准」：');
  console.log('  窗口                          命中/期数   命中率  随机期望   左尾p   右尾p');
  for (const L of [5, 10, 12, 15, 20, 30, 50, 77].filter(x => x <= N)) {
    const seg = rows.slice(-L), k = seg.filter(r => r.hit).length;
    console.log(`  最近 ${String(L).padStart(2)} 期 ${seg[0].label}~${seg[seg.length - 1].label}   ${String(k).padStart(2)}/${String(L).padStart(2)}  ${(k / L * 100).toFixed(2).padStart(6)}%  ${(L / 7).toFixed(2).padStart(6)}  ${binomLeftTail(L, k).toFixed(4)}  ${binomRightTail(L, k).toFixed(4)}`);
  }
  {
    let kmax = -1;
    for (let k = 0; k <= N; k++) if (binomLeftTail(N, k) <= 0.05) kmax = k;
    console.log(`  注：要把「偏低」判成显著（单边 α=0.05），当前 N=${N} 需 K<=${kmax < 0 ? '（无论多低都不显著）' : kmax}；窗口越短门槛越苛刻（如 N=20 需 0 次命中才算显著）。`);
  }

  console.log('\n命中期与位次（第几位命中）：');  if (!K) console.log('  （无命中）');  const pos = Array(7).fill(0);
  for (const r of rows) if (r.hit) { const i = r.pred.indexOf(r.actual); pos[i]++; console.log(`  ${r.label}  特码 ${String(r.actual).padStart(2, '0')} 第 ${i + 1} 位`); }
  if (K) console.log(`  位次分布 1~7：${pos.join(' / ')}（前5码 ${pos.slice(0, 5).reduce((a, b) => a + b, 0)} 次，6-7位 ${pos.slice(5).reduce((a, b) => a + b, 0)} 次）`);

  const b = rows.map(r => r.hit ? 1 : 0);
  let mx = 0, cur = 0;
  for (const x of b) { if (!x) { cur++; if (cur > mx) mx = cur; } else cur = 0; }
  const adj = b.filter((x, i) => x && i > 0 && b[i - 1]).length;
  console.log(`\n连挂最长 ${mx} 期 · 相邻两期连中 ${adj} 处（随机期望 ${((N - 1) / 49).toFixed(2)} 处）`);

  const board = {};
  for (const r of rows) for (const n of r.pred) board[n] = (board[n] || 0) + 1;
  const top = Object.entries(board).sort((a, c) => c[1] - a[1]);
  console.log(`\n候选池：${N} 期共用到 ${top.length} 个不同号码；上榜次数前 10：` +
    top.slice(0, 10).map(([n, c]) => `${n}(${c})`).join(' '));

  /* ---------- 预注册：第 100 期的判定门槛 ----------
     门槛在数据到齐之前就算好并写死在这里，避免看到结果以后再挪动判定线。
     2026-10-17：波色并列 bug 修复后，旧预注册（2026-201 起、目标 2026-300）作废，
     新预注册从 PREREG_START 起算 100 期。 */
  const PREREG_START = '2026-290';
  const GOAL = 100;
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const labelAfter = (label, steps) => {
    let [y, p] = label.split('-').map(Number);
    for (let i = 0; i < steps; i++) { p++; if (p > (leap(y) ? 366 : 365)) { p = 1; y++; } }
    return `${y}-${String(p).padStart(3, '0')}`;
  };
  const needP = (alpha) => { const k0 = Math.floor(GOAL / 7); for (let k = k0; k <= GOAL; k++) if (binomRightTail(GOAL, k) < alpha) return k; return null; };
  const k05 = needP(0.05), k10 = needP(0.10);
  console.log(`\n预注册（修复后引擎）：起点 ${PREREG_START} · 目标第 ${GOAL} 期 ${labelAfter(PREREG_START, GOAL - 1)}`);
  console.log(`  N=${GOAL} 判定门槛：K>=${k05} → p=${binomRightTail(GOAL, k05).toFixed(4)} 显著；` +
    `K=${k10} → p=${binomRightTail(GOAL, k10).toFixed(4)} 边缘；K<=${k10 - 1} → 不显著`);
  const pre = T.computeForward(PREREG_START);
  if (pre.error) {
    console.log(`  尚未开始：数据里还没有 ${PREREG_START}（当前数据到 ${latest}）。`);
  } else {
    const done = pre.rows.length, kdone = pre.rows.filter(r => r.hit).length;
    console.log(`  进度：${done}/${GOAL} 期，命中 ${kdone} 次（${(kdone / done * 100).toFixed(2)}%）`);
    if (done < GOAL) {
      const remain = GOAL - done, needHit = k05 - kdone;
      console.log(`  到点前还需在 ${remain} 期里命中 ${needHit >= 0 ? '>=' + needHit : '（已不可能显著）'} 次` +
        (needHit > 0 ? `（${(needHit / remain * 100).toFixed(1)}%）` : ''));
      if (needHit > 0) console.log(`  纯随机下达成概率 ${(binomRightTail(remain, needHit) * 100).toFixed(1)}%`);
    } else {
      console.log(`  到期判定：K=${kdone} → 精确右尾 p=${binomRightTail(done, kdone).toFixed(4)}（K>=${k05} 才显著）`);
    }
  }
}

main();
