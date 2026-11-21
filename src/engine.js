'use strict';
// 选号内核移植自用户提供的《三中三(2).html》，仅使用前六个平码；第 7 位特码只做记录与命中统计，不进入评分。
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

function pickBalancedSeven(scoreMap) {
  const sorted = Array.from({ length: 49 }, (_, i) => i + 1)
    .filter(n => scoreMap[n] > -900)
    .sort((a, b) => scoreMap[b] - scoreMap[a] || a - b);
  const out = [];
  const z = [0, 0, 0, 0];
  const c = { red: 0, blue: 0, green: 0 };
  const t = new Uint8Array(10);
  const used = new Set();

  for (const strict of [true, false]) {
    for (const n of sorted) {
      if (out.length >= 7) break;
      if (used.has(n)) continue;
      if (strict && (z[zoneOf(n)] >= 3 || c[WAVE_MAP[n]] >= 3 || t[n % 10] >= 2)) continue;
      out.push(n);
      used.add(n);
      z[zoneOf(n)]++;
      c[WAVE_MAP[n]]++;
      t[n % 10]++;
    }
  }
  return out.sort((a, b) => a - b);
}

function run3in3At(usableAsc, P, year, periodNum, dateStr) {
  const effDate = dateStr || (P > 0 ? usableAsc[P - 1].date : `${year}-01-01`);
  const baseZ = yearZodiacBaseIdx(effDate);

  const nOmit = new Int16Array(50).fill(80);
  const nF2 = new Int16Array(50), nF5 = new Int16Array(50), nF10 = new Int16Array(50), nF20 = new Int16Array(50), nF40 = new Int16Array(50);
  const tail8 = new Int16Array(10), tail10 = new Int16Array(10);
  const wave5 = { red: 0, blue: 0, green: 0 };

  const win = Math.min(80, P);
  for (let k = 1; k <= win; k++) {
    const norms = usableAsc[P - k].numbers;
    for (let i = 0; i < 6; i++) {
      const a = norms[i];
      if (nOmit[a] === 80) nOmit[a] = k - 1;
      if (k <= 2) nF2[a]++;
      if (k <= 5) { nF5[a]++; wave5[WAVE_MAP[a]]++; }
      if (k <= 8) tail8[a % 10]++;
      if (k <= 10) { nF10[a]++; tail10[a % 10]++; }
      if (k <= 20) nF20[a]++;
      if (k <= 40) nF40[a]++;
    }
  }

  const ema12 = new Float64Array(50).fill(6 / 49);
  const alpha = 2 / 13, keep = 1 - alpha;
  for (let idx = Math.max(0, P - 36); idx < P; idx++) {
    for (let n = 1; n <= 49; n++) ema12[n] *= keep;
    for (const x of usableAsc[idx].numbers) ema12[x] += alpha;
  }

  const last1 = new Set(P > 0 ? usableAsc[P - 1].numbers : []);
  const last2 = new Set(P > 1 ? usableAsc[P - 2].numbers : []);
  const last3 = new Set(P > 2 ? usableAsc[P - 3].numbers : []);

  const jitter = (num, salt) => {
    let x = ((year * 1009 + periodNum * 9176 + num * 379 + salt * 131071) >>> 0) || 1;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000 * 0.06;
  };

  const s1 = new Float64Array(50);
  const s2 = new Float64Array(50);
  const s3 = new Float64Array(50);
  const sOpt = new Float64Array(50);
  const normMeta = new Array(50);

  for (let n = 1; n <= 49; n++) {
    const tl = n % 10;
    const zIdx = ((baseZ - (n - 1)) % 12 + 12) % 12;
    const clamp = (n > 1 && n < 49 && last1.has(n - 1) && last1.has(n + 1)) ? 0.40 : 0;

    // #1 连庄强热：上期前6平码重开 + 隔期回头 + 近5期高频平码
    s1[n] = (last1.has(n) ? 1.55 : 0)
          + (last2.has(n) ? 1.25 : 0)
          + 0.80 * nF5[n]
          + 0.30 * nF10[n]
          + 1.80 * ema12[n]
          + clamp
          + jitter(n, 13);

    // #2 回马旺尾：歇1~3期平码回马枪 + 旺尾抱团 + 40期活跃平码底盘
    s2[n] = (nOmit[n] >= 1 && nOmit[n] <= 2 ? 1.45 : nOmit[n] === 3 ? 0.95 : 0)
          + (last3.has(n) ? 0.55 : 0)
          + 0.38 * tail8[tl]
          + 0.24 * nF40[n]
          + 0.14 * wave5[WAVE_MAP[n]]
          + jitter(n, 41);

    // #3 滞冷断档（反向杀号池）：平码遗漏>=12期死水球 + 20期透支停火球
    const overBurn = (nF20[n] >= 5 && nOmit[n] >= 3) ? 1.50 : 0;
    s3[n] = (nOmit[n] >= 18 ? 2.40 : nOmit[n] >= 12 ? 1.50 : nOmit[n] >= 7 ? 0.70 : 0)
          + overBurn
          + (tail10[tl] <= 2 ? 0.65 : 0)
          - 1.20 * nF2[n]
          + jitter(n, 83);

    normMeta[n] = { zodiac: ZODIACS[zIdx], omit: nOmit[n], f10: nF10[n] };
  }

  const all49 = Array.from({ length: 49 }, (_, i) => i + 1);
  const g1 = [...all49].sort((a, b) => s1[b] - s1[a] || a - b).slice(0, 7).sort((a, b) => a - b);
  const g2 = [...all49].sort((a, b) => s2[b] - s2[a] || a - b).slice(0, 7).sort((a, b) => a - b);
  const g3 = [...all49].sort((a, b) => s3[b] - s3[a] || a - b).slice(0, 7).sort((a, b) => a - b);

  const killSet = new Set(g3);
  for (let n = 1; n <= 49; n++) {
    if (killSet.has(n) || nOmit[n] >= 12 || (nF20[n] >= 6 && !last1.has(n))) {
      sOpt[n] = -999;
      continue;
    }
    const clamp = (n > 1 && n < 49 && last1.has(n - 1) && last1.has(n + 1)) ? 0.40 : 0;
    sOpt[n] = (last1.has(n) ? 1.50 : 0)
            + (last2.has(n) ? 1.25 : 0)
            + 0.85 * nF5[n]
            + 0.25 * nF10[n]
            + 1.80 * ema12[n]
            + 0.18 * tail10[n % 10]
            + clamp
            + jitter(n, 17);
  }
  const opt = pickBalancedSeven(sOpt);
  const dualShared = opt.filter(n => g2.includes(n));

  return {
    opt,
    groups: { g1, g2, g3 },
    scores: { g1: s1, g2: s2, g3: s3 },
    normMeta,
    killList: g3,
    dualShared
  };
}


function zodiacOfNumber(num, dateStr) {
  return zodiacByBase(num, yearZodiacBaseIdx(dateStr));
}

if (typeof module !== 'undefined') module.exports = {
  run3in3At, validSixNums, parseLabel, nextLabelOf, periodToDate, countTriples, buildAll35Triples,
  pad2, escapeHtml, zoneOf, maxPeriodOfYear, zodiacOfNumber, yearZodiacBaseIdx, zodiacByBase,
  WAVE_MAP, WAVE_COLOR, ZODIACS, LUNAR_NEW_YEAR_DATES
};
