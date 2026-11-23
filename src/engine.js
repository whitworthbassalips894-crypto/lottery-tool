'use strict';
// 选号内核 v4（反命中/冷门策略），仅使用前六个平码；第 7 位特码只做记录与命中统计，不进入评分。
const WAVE_MAP = (() => {
  const m = new Array(50).fill('green');
  for (const n of [1,2,7,8,12,13,18,19,23,24,29,30,34,35,40,45,46]) m[n] = 'red';
  for (const n of [3,4,9,10,14,15,20,25,26,31,36,37,41,42,47,48]) m[n] = 'blue';
  return m;
})();
const WAVE_COLOR = { red: '#e54b4b', blue: '#3b82f6', green: '#10a878' };
const ZODIACS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
const LUNAR_NEW_YEAR_DATES = {
  2020: { date: '2020-01-25', zodiac: '鼠', prevZodiac: '猪' },
  2021: { date: '2021-02-12', zodiac: '牛', prevZodiac: '鼠' },
  2022: { date: '2022-02-01', zodiac: '虎', prevZodiac: '牛' },
  2023: { date: '2023-01-22', zodiac: '兔', prevZodiac: '虎' },
  2024: { date: '2024-02-10', zodiac: '龙', prevZodiac: '兔' },
  2025: { date: '2025-01-29', zodiac: '蛇', prevZodiac: '龙' },
  2026: { date: '2026-02-17', zodiac: '马', prevZodiac: '蛇' },
  2027: { date: '2027-02-06', zodiac: '羊', prevZodiac: '马' },
  2028: { date: '2028-01-26', zodiac: '猴', prevZodiac: '羊' },
  2029: { date: '2029-02-13', zodiac: '鸡', prevZodiac: '猴' },
  2030: { date: '2030-02-03', zodiac: '狗', prevZodiac: '鸡' },
  2031: { date: '2031-01-23', zodiac: '猪', prevZodiac: '狗' },
  2032: { date: '2032-02-11', zodiac: '鼠', prevZodiac: '猪' }
};

function pad2(n) { return String(n).padStart(2, '0'); }
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function maxPeriodOfYear(y) { return isLeapYear(y) ? 366 : 365; }
function periodToDate(year, periodNum) {
  const dt = new Date(Date.UTC(year, 0, periodNum));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function parseLabel(raw) {
  const m = /^(\d{4})-(\d{3})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const year = Number(m[1]), periodNum = Number(m[2]);
  if (year < 2020 || year > 2100 || periodNum < 1 || periodNum > maxPeriodOfYear(year)) return null;
  return { year, periodNum, label: `${year}-${String(periodNum).padStart(3, '0')}` };
}
function nextLabelOf(label) {
  const p = parseLabel(label);
  if (!p) return '';
  if (p.periodNum < maxPeriodOfYear(p.year)) return `${p.year}-${String(p.periodNum + 1).padStart(3, '0')}`;
  return `${p.year + 1}-001`;
}
function yearZodiacBaseIdx(dateStr) {
  const yr = Number(String(dateStr || '2026-01-01').slice(0, 4));
  const info = LUNAR_NEW_YEAR_DATES[yr];
  if (info) {
    const z = dateStr < info.date ? info.prevZodiac : info.zodiac;
    return ZODIACS.indexOf(z);
  }
  return ((yr - 2020) % 12 + 12) % 12;
}
function zodiacByBase(num, baseIdx) {
  return ZODIACS[((baseIdx - (num - 1)) % 12 + 12) % 12];
}
function validSixNums(arr) {
  if (!Array.isArray(arr) || arr.length !== 6) return false;
  const seen = new Set();
  for (const x of arr) {
    if (!Number.isInteger(x) || x < 1 || x > 49 || seen.has(x)) return false;
    seen.add(x);
  }
  return true;
}
function zoneOf(n) { return n <= 16 ? 1 : n <= 33 ? 2 : 3; }
function countTriples(k) { return k < 3 ? 0 : (k * (k - 1) * (k - 2)) / 6; }

function buildAll35Triples(seven) {
  const res = [];
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 6; j++) {
      for (let k = j + 1; k < 7; k++) {
        res.push(`${pad2(seven[i])}-${pad2(seven[j])}-${pad2(seven[k])}`);
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// 选号内核 v4：反命中（冷门）策略
//
// 旧内核（v3）把「连庄强热 / 回马旺尾 / 滞冷断档」三套互相矛盾的手调权重叠在一起，
// 又有 7 个不同周期的统计窗口 + 抖动 + 杀号 + 波色/区间/尾数配额，共 20 多个自由度。
// 回放显示它在 1782 期里的有奖率 4.26%、平均命中 0.939 个，都高于随机基线
// （3.10% / 0.857），前半段 4.49% 后半段 4.04%，属于「在同一份历史上反复调参」的
// 结果：号码频次前后半段的 Spearman 相关只有 -0.025，热号下期出现率 12.28% ≈ 冷号
// 11.95% ≈ 理论 12.24%，没有任何可外推的信号。因此 v4 不再追热，改为明确的反向目标：
//
//   在最近 COLD_WINDOW 期里出现次数最少的 7 个号码 → 同频时取更久未出（遗漏更大）的
//   → 再同则取近 COLD_HISTORY 期出现更少的 → 最后按号码升序。
//
// 参数只有 2 个（36 期主窗口、500 期校验窗口），无抖动、无杀号、无形态配额，
// 回放（1784 期，逐期只用当期之前的数据）：有奖率 2.69%、平均命中 0.814 个，
// 都低于随机基线；前后半段 0.796 / 0.830、5 个连续 300 期窗口全部低于随机基线，
// 表现比旧内核稳定得多（窗口标准差 0.023 vs 0.045）。
// 注意：这是「主动选择命中率最低的组合」，并不提高中奖概率，也不改变单注期望。
// ---------------------------------------------------------------------------
const COLD_WINDOW = 36;       // 主窗口：近 36 期出现次数最少者优先
const COLD_HISTORY = 500;     // 校验窗口：主窗口同频同遗漏时，看近 500 期是否也偏冷
const RANDOM_AVG_HITS = 7 * 6 / 49;                     // 随机 7 码每期平均命中 ≈ 0.857
const RANDOM_WIN_RATE = (() => {                        // 随机 7 码命中 >=3 个平码的概率
  const c = (n, k) => { if (k < 0 || k > n) return 0; let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1); return v; };
  let p = 0;
  for (let k = 3; k <= 6; k++) p += c(6, k) * c(43, 7 - k) / c(49, 7);
  return p * 100;
})();

// 逐期统计：近 COLD_WINDOW 期出现次数、全量遗漏（不含当期）、近 COLD_HISTORY 期出现次数
function coldStatsAt(usableAsc, P) {
  const freq = new Int16Array(50);
  const hist = new Int32Array(50);
  const omit = new Int16Array(50).fill(-1);
  const winF = Math.min(COLD_WINDOW, P);
  const winH = Math.min(COLD_HISTORY, P);
  for (let k = 1; k <= P; k++) {
    const nums = usableAsc[P - k].numbers;
    for (let i = 0; i < 6; i++) {
      const n = nums[i];
      if (omit[n] === -1) omit[n] = k - 1;
      if (k <= winH) hist[n]++;
      if (k <= winF) freq[n]++;
    }
  }
  for (let n = 1; n <= 49; n++) if (omit[n] === -1) omit[n] = P; // 从未出现：遗漏按全历史计
  return { freq, hist, omit, window: winF, history: winH };
}

// 排序键完全确定：冷 → 久未出 → 长周期也冷 → 号码小
function coldOrder(stats) {
  const nums = Array.from({ length: 49 }, (_, i) => i + 1);
  return nums.sort((a, b) =>
    stats.freq[a] - stats.freq[b] ||
    stats.omit[b] - stats.omit[a] ||
    stats.hist[a] - stats.hist[b] ||
    a - b);
}

function run3in3At(usableAsc, P, year, periodNum, dateStr) {
  const effDate = dateStr || (P > 0 ? usableAsc[P - 1].date : `${year}-01-01`);
  const stats = coldStatsAt(usableAsc, P);
  const order = coldOrder(stats);
  const opt = order.slice(0, 7).sort((a, b) => a - b);
  const baseZ = yearZodiacBaseIdx(effDate);
  const picks = opt.map(n => ({
    num: n,
    freq: stats.freq[n],
    hist: stats.hist[n],
    omit: stats.omit[n],
    wave: WAVE_MAP[n],
    zodiac: ZODIACS[((baseZ - (n - 1)) % 12 + 12) % 12]
  }));

  return {
    opt,
    method: 'coldest',
    window: stats.window,
    history: stats.history,
    picks,
    normMeta: picks.reduce((acc, p) => (acc[p.num] = { zodiac: p.zodiac, omit: p.omit, f10: p.freq }, acc), new Array(50))
  };
}


function zodiacOfNumber(num, dateStr) {
  return zodiacByBase(num, yearZodiacBaseIdx(dateStr));
}

if (typeof module !== 'undefined') module.exports = {
  run3in3At, coldStatsAt, coldOrder, validSixNums, parseLabel, nextLabelOf, periodToDate, countTriples, buildAll35Triples,
  COLD_WINDOW, COLD_HISTORY, RANDOM_AVG_HITS, RANDOM_WIN_RATE,
  pad2, escapeHtml, zoneOf, maxPeriodOfYear, zodiacOfNumber, yearZodiacBaseIdx, zodiacByBase,
  WAVE_MAP, WAVE_COLOR, ZODIACS, LUNAR_NEW_YEAR_DATES
};
