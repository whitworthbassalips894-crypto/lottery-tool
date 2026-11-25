'use strict';
// 选号内核 v6（固定 7 码）：主推号码为人工指定的固定一组 7 码，不随历史数据变化；第 7 位特码只做记录与命中统计，不参与选号。
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
// 今天（UTC）的 YYYY-MM-DD。用来判断本机数据是否已经落后——目标期号的日期一旦早于今天，
// 就说明本机停在过去的期次，照着首屏买会买错期。
function todayUTC(now) {
  const d = now == null ? new Date() : new Date(now);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
// 两个 ISO 日期相差几天（to - from）。任一非法返回 null，不猜。
function daysBetween(from, to) {
  const a = Date.parse(from), b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}
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
// 选号内核 v6：固定 7 码
//
// 按用户要求：主推号码固定为下面这一组，不再由任何算法（随机、冷门、饱和度、
// 频次、遗漏等）生成，也不随历史开奖变化——同一组号一直用，便于长期跟号与对账。
//
// 这组号的来源：附件《7码版双引擎融合修复_33b724e5.html》左侧「引擎A · 纯净版
// （固定参数）」给出的当期 7 码（原表顺序 34、39、46、16、6、1、43，按升序存放）。
// 按用户要求换用这组号；换号后回放、指标卡与复制文案自动跟随。
// ---------------------------------------------------------------------------
const FIXED_SEVEN = Object.freeze([1, 6, 16, 34, 39, 43, 46]);

// 随机基线常量：仅用于指标卡对照，与实际选号无关
const RANDOM_AVG_HITS = 7 * 6 / 49;                     // 随机 7 码每期平均命中 ≈ 0.857
const RANDOM_AVG_INTERVAL = 1 / (() => {                // 平均多少期出现一次三中三
  const c = (n, k) => { if (k < 0 || k > n) return 0; let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1); return v; };
  let p = 0;
  for (let k = 3; k <= 6; k++) p += c(6, k) * c(43, 7 - k) / c(49, 7);
  return p;
})();
const RANDOM_WIN_RATE = 100 / RANDOM_AVG_INTERVAL;      // ≈ 3.095%

// 固定 7 码的副本（升序），调用方随意修改也不会污染常量
function fixedSeven() {
  return FIXED_SEVEN.slice().sort((a, b) => a - b);
}

// 兼容旧签名：P/year/periodNum 仍用于定位期号与日期，但不再影响号码
function run3in3At(usableAsc, P, year, periodNum, dateStr) {
  const label = `${year}-${String(periodNum).padStart(3, '0')}`;
  const effDate = dateStr || (P > 0 ? usableAsc[P - 1].date : periodToDate(year, periodNum));
  const opt = fixedSeven();
  const baseZ = yearZodiacBaseIdx(effDate);
  const picks = opt.map(n => ({
    num: n,
    wave: WAVE_MAP[n],
    zodiac: ZODIACS[((baseZ - (n - 1)) % 12 + 12) % 12]
  }));
  return {
    opt,
    method: 'fixed',
    label,
    date: effDate,
    picks,
    normMeta: picks.reduce((acc, p) => (acc[p.num] = { zodiac: p.zodiac }, acc), new Array(50))
  };
}


function zodiacOfNumber(num, dateStr) {
  return zodiacByBase(num, yearZodiacBaseIdx(dateStr));
}

if (typeof module !== 'undefined') module.exports = {
  run3in3At, fixedSeven, FIXED_SEVEN, validSixNums, parseLabel, nextLabelOf,
  periodToDate, countTriples, buildAll35Triples,
  RANDOM_AVG_HITS, RANDOM_AVG_INTERVAL, RANDOM_WIN_RATE,
  pad2, escapeHtml, zoneOf, maxPeriodOfYear, zodiacOfNumber, yearZodiacBaseIdx, zodiacByBase,
  todayUTC, daysBetween,
  WAVE_MAP, WAVE_COLOR, ZODIACS, LUNAR_NEW_YEAR_DATES
};
