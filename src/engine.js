'use strict';
// 选号内核 v5（每日随机）：按期号做种子的均匀随机 7 码，仅使用前六个平码；第 7 位特码只做记录与命中统计，不参与选号。
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
// 选号内核 v5：每日随机 7 码
//
// 为什么不再用任何"统计规律"：v3 的三套热/冷评分与 v4 的冷门排序，在同一份历史上
// 都能被调出"比随机好"或"比随机差"的结果（v3 有奖率 4.26%、v4 2.69%，随机 3.10%），
// 但号码频次前后半段 Spearman 只有 -0.025、热号下期出现率 12.28% ≈ 冷号 11.95% ≈
// 理论 12.24%，没有任何可外推的信息。既然信号不存在，任何"算法"只是在拟合噪声，
// 于是直接采信随机：每期从 1~49 均匀不放回抽 7 个号码。
//
// 随机也必须"可复现"，否则同一期每次打开页面都换一组，票就没法照着买。
// 做法：按期号（如 2026-325）做种子 → xmur3 混洗 + mulberry32 → 部分 Fisher–Yates
// 从 1~49 抽出 7 个 → 升序输出。因此：
//   · 同一期号永远得到同一组号码（刷新、重开、换设备都一致）；
//   · 不同期号互相独立，等于每期独立随机；
//   · 完全不读取历史开奖与特码，7 码与"热/冷/遗漏"再无关系。
// 长期口径（数学期望，不随选号方法改变）：命中 ≥3 个平码 3.095%/期（平均 32.3 期一次）、
// 平均命中 0.857 个平码、每期 70 元投入的期望返奖 53.2 元 ≈ 76%。
// ---------------------------------------------------------------------------
const DAILY_SALT = 'three-in-three-daily-v5';
const RANDOM_AVG_HITS = 7 * 6 / 49;                     // 随机 7 码每期平均命中 ≈ 0.857
const RANDOM_AVG_INTERVAL = 1 / (() => {                // 平均多少期出现一次三中三
  const c = (n, k) => { if (k < 0 || k > n) return 0; let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1); return v; };
  let p = 0;
  for (let k = 3; k <= 6; k++) p += c(6, k) * c(43, 7 - k) / c(49, 7);
  return p;
})();
const RANDOM_WIN_RATE = 100 / RANDOM_AVG_INTERVAL;      // ≈ 3.095%

// 字符串 → 32 位种子（xmur3）
function seedFromString(str) {
  const text = String(str || '');
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// 32 位种子 → [0,1) 均匀随机数（mulberry32）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 按期号做种子，从 1~49 均匀不放回抽 7 个（部分 Fisher–Yates），升序返回
function dailyRandomSeven(label) {
  const key = String(label || '').trim();
  if (!/^\d{4}-\d{3}$/.test(key)) throw new Error('期号格式无效：' + label);
  const rand = mulberry32(seedFromString(`${DAILY_SALT}|${key}`));
  const pool = Array.from({ length: 49 }, (_, i) => i + 1);
  for (let i = 0; i < 7; i++) {
    const j = i + Math.floor(rand() * (49 - i));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, 7).sort((a, b) => a - b);
}

// 与 run3in3At 相同的签名：仍只用历史条数定位期号，不读取任何开奖号码
function run3in3At(usableAsc, P, year, periodNum, dateStr) {
  const label = `${year}-${String(periodNum).padStart(3, '0')}`;
  const effDate = dateStr || (P > 0 ? usableAsc[P - 1].date : periodToDate(year, periodNum));
  const opt = dailyRandomSeven(label);
  const baseZ = yearZodiacBaseIdx(effDate);
  const picks = opt.map(n => ({
    num: n,
    wave: WAVE_MAP[n],
    zodiac: ZODIACS[((baseZ - (n - 1)) % 12 + 12) % 12]
  }));
  return {
    opt,
    method: 'daily-random',
    label,
    date: effDate,
    seed: seedFromString(`${DAILY_SALT}|${label}`),
    picks,
    normMeta: picks.reduce((acc, p) => (acc[p.num] = { zodiac: p.zodiac }, acc), new Array(50))
  };
}


function zodiacOfNumber(num, dateStr) {
  return zodiacByBase(num, yearZodiacBaseIdx(dateStr));
}

if (typeof module !== 'undefined') module.exports = {
  run3in3At, dailyRandomSeven, seedFromString, mulberry32, validSixNums, parseLabel, nextLabelOf,
  periodToDate, countTriples, buildAll35Triples,
  DAILY_SALT, RANDOM_AVG_HITS, RANDOM_AVG_INTERVAL, RANDOM_WIN_RATE,
  pad2, escapeHtml, zoneOf, maxPeriodOfYear, zodiacOfNumber, yearZodiacBaseIdx, zodiacByBase,
  WAVE_MAP, WAVE_COLOR, ZODIACS, LUNAR_NEW_YEAR_DATES
};
