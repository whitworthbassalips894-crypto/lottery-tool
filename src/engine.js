'use strict';
// 选号内核（引擎A · 纯净版，固定参数）：基于历史开奖动态计算 7 码推荐；第 7 位特码只做记录与命中统计，不参与选号。
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
// 选号内核：引擎A · 纯净版（固定参数）
// 来源：附件《7码版双引擎融合修复_33b724e5.html》中的 simulateEngine(hist)。
// 7 码随历史开奖变化：每一期基于该期之前的历史计算，不是固定常量。
// ---------------------------------------------------------------------------

function getZoneAE(n) { return n <= 10 ? 'A' : n <= 20 ? 'B' : n <= 30 ? 'C' : n <= 40 ? 'D' : 'E'; }
function isOdd(n) { return n % 2 !== 0; }
function isBig(n) { return n >= 25; }

// 将本工具的记录格式转为引擎A期望的 hist 元素：[n1..n6, special]，并挂 _label
function toEngineHist(records, P) {
  const out = [];
  const limit = Math.max(0, Math.min(P, records.length));
  for (let i = 0; i < limit; i++) {
    const r = records[i];
    if (!r || !Array.isArray(r.numbers) || r.numbers.length !== 6) continue;
    if (!Number.isInteger(r.special) || r.special < 1 || r.special > 49) continue;
    const arr = r.numbers.slice(0, 6).map(Number);
    arr.push(Number(r.special));
    arr._label = r.label;
    arr._year = r.year;
    out.push(arr);
  }
  return out;
}

// 引擎A · 纯净版（固定参数）——忠实移植自附件 simulateEngine(hist)
function simulateEngineA(hist, targetLabel) {
  if (!Array.isArray(hist) || hist.length < 60) return null;
  const attr = 45, window = 150;
  const t = hist.length;
  let oddCount = 0, bigCount = 0;
  const waveCounts = { red: 0, blue: 0, green: 0 };
  for (let i = t - attr; i < t; i++) {
    const n = hist[i][6];
    if (isOdd(n)) oddCount++;
    if (isBig(n)) bigCount++;
    waveCounts[WAVE_MAP[n]]++;
  }
  const predOdd = oddCount >= attr / 2 ? 'odd' : 'even';
  const predBig = bigCount >= attr / 2;
  const predWave = Object.keys(waveCounts).reduce((a, b) => waveCounts[a] < waveCounts[b] ? a : b);
  const freq = Array(50).fill(0), last = Array(50).fill(-1);
  const appearances = Array.from({ length: 50 }, () => []);
  for (let i = 0; i < t; i++) {
    const n = hist[i][6];
    if (i >= t - window) freq[n]++;
    last[n] = i;
    appearances[n].push(i);
  }
  const maxOmit = Array(50).fill(0), saturation = Array(50).fill(0);
  for (let n = 1; n <= 49; n++) {
    const idx = appearances[n];
    if (idx.length === 0) { maxOmit[n] = t; saturation[n] = 1; }
    else {
      let mx = idx[0];
      for (let j = 1; j < idx.length; j++) mx = Math.max(mx, idx[j] - idx[j - 1] - 1);
      mx = Math.max(mx, t - 1 - idx[idx.length - 1]);
      maxOmit[n] = mx;
      const omit = last[n] < 0 ? t : t - 1 - last[n];
      saturation[n] = mx > 0 ? omit / mx : 0;
    }
  }
  const scores = [];
  const W = { freq: 3, wave: 14 };
  for (let n = 1; n <= 49; n++) {
    const sat = saturation[n], zone = getZoneAE(n);
    let satScore;
    if (sat >= 1.0) satScore = 25; else if (sat >= 0.96) satScore = 42; else if (sat >= 0.90) satScore = 38; else if (sat >= 0.85) satScore = 45;
    else if (sat >= 0.80) satScore = 5; else if (sat >= 0.75) satScore = -15; else if (sat >= 0.70) satScore = 2; else if (sat >= 0.55) satScore = -10;
    else if (sat >= 0.50) satScore = -12; else if (sat >= 0.45) satScore = -3; else if (sat >= 0.20) satScore = 0; else if (sat >= 0.15) satScore = 12;
    else if (sat >= 0.10) satScore = 8; else if (sat >= 0.05) satScore = 2; else satScore = 1;
    let score = satScore + freq[n] * W.freq;
    if (WAVE_MAP[n] === predWave) score += W.wave;
    scores.push({ n, score, sat, omit: last[n] < 0 ? t : t - 1 - last[n], maxOmit: maxOmit[n], zone });
  }
  scores.sort((a, b) => b.score - a.score || a.n - b.n);
  const top7 = []; const usedZones = new Set(); const s5 = scores[4] ? scores[4].score : 0;
  const cutLine = s5 - 0.2 * Math.abs(s5); // 与附件一致：避免负分区反转
  for (const s of scores) {
    if (top7.length >= 7) break;
    if (top7.length < 5 || !usedZones.has(s.zone) || s.score < cutLine || top7.length >= 6) { top7.push(s); usedZones.add(s.zone); }
  }
  if (top7.length < 7) { for (const s of scores) { if (!top7.find(x => x.n === s.n)) { top7.push(s); if (top7.length >= 7) break; } } }
  return { predOdd, predBig, predWave, pick: top7.map(x => x.n), fullScores: top7, targetLabel };
}

// 随机基线常量：仅用于指标卡对照，与实际选号无关
const RANDOM_AVG_HITS = 7 * 6 / 49;                     // 随机 7 码每期平均命中 ≈ 0.857
const RANDOM_AVG_INTERVAL = 1 / (() => {                // 平均多少期出现一次三中三
  const c = (n, k) => { if (k < 0 || k > n) return 0; let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1); return v; };
  let p = 0;
  for (let k = 3; k <= 6; k++) p += c(6, k) * c(43, 7 - k) / c(49, 7);
  return p;
})();
const RANDOM_WIN_RATE = 100 / RANDOM_AVG_INTERVAL;      // ≈ 3.095%

// 兼容旧签名：P 表示使用 usableAsc 前 P 期作为历史，推荐目标为 year-periodNum
function run3in3At(usableAsc, P, year, periodNum, dateStr) {
  const label = `${year}-${String(periodNum).padStart(3, '0')}`;
  const effDate = dateStr || (P > 0 ? usableAsc[P - 1].date : periodToDate(year, periodNum));
  const hist = toEngineHist(usableAsc || [], P);
  const result = simulateEngineA(hist, label);
  if (!result) {
    return {
      opt: [], method: 'engineA', label, date: effDate, picks: [],
      normMeta: new Array(50), predOdd: null, predBig: null, predWave: null, fullScores: []
    };
  }
  const opt = result.pick.slice().sort((a, b) => a - b);
  const picks = opt.map(n => ({
    num: n,
    wave: WAVE_MAP[n],
    zodiac: zodiacOfNumber(n, effDate)
  }));
  return {
    opt,
    method: 'engineA',
    label,
    date: effDate,
    picks,
    normMeta: picks.reduce((acc, p) => (acc[p.num] = { zodiac: p.zodiac }, acc), new Array(50)),
    predOdd: result.predOdd,
    predBig: result.predBig,
    predWave: result.predWave,
    fullScores: result.fullScores
  };
}


function zodiacOfNumber(num, dateStr) {
  return zodiacByBase(num, yearZodiacBaseIdx(dateStr));
}

if (typeof module !== 'undefined') module.exports = {
  run3in3At, simulateEngineA, toEngineHist, getZoneAE,
  validSixNums, parseLabel, nextLabelOf,
  periodToDate, countTriples, buildAll35Triples,
  RANDOM_AVG_HITS, RANDOM_AVG_INTERVAL, RANDOM_WIN_RATE,
  pad2, escapeHtml, zoneOf, maxPeriodOfYear, zodiacOfNumber, yearZodiacBaseIdx, zodiacByBase,
  todayUTC, daysBetween,
  WAVE_MAP, WAVE_COLOR, ZODIACS, LUNAR_NEW_YEAR_DATES
};
