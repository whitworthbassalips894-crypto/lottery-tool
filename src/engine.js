'use strict';
// 选号内核（热冷随机 v1，固定规则）：3热 + 2冷 + 2随机，基于历史平码动态计算 7 码推荐；确定性种子，可追踪复现。
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
// 选号内核：热冷随机 v1（固定规则，可追踪）
// 规则：3热 + 2冷 + 2随机 = 7码。热/冷基于目标期之前的平码历史。
// 随机选取使用确定性种子，保证同一数据/同一期/同一规则版本可复现。
// ---------------------------------------------------------------------------

const HCR_RULE_VERSION = 'hcr-v1';
const HCR_HOT_WINDOW = 60;
const HCR_HOT_POOL = 10;
const HCR_COLD_POOL = 10;
const HCR_PICK_HOT = 3;
const HCR_PICK_COLD = 2;
const HCR_PICK_RANDOM = 2;
const HCR_MIN_HISTORY = 60;

function hashString(str) {
  // FNV-1a 32-bit
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicPick(arr, k, rng) {
  const pool = arr.slice();
  const picked = [];
  for (let i = 0; i < k && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

function buildHcrTrace(records, P, targetLabel) {
  const limit = Math.max(0, Math.min(P, records.length));
  const hist = [];
  for (let i = 0; i < limit; i++) {
    const r = records[i];
    if (!r || !Array.isArray(r.numbers) || r.numbers.length !== 6) continue;
    hist.push(r);
  }
  if (hist.length < HCR_MIN_HISTORY) return null;

  const last60 = hist.slice(-HCR_HOT_WINDOW);
  const hotFreq = Array(50).fill(0);
  for (const r of last60) for (const n of r.numbers) if (n >= 1 && n <= 49) hotFreq[n]++;

  const lastSeen = Array(50).fill(-1);
  for (let i = 0; i < hist.length; i++) for (const n of hist[i].numbers) if (n >= 1 && n <= 49) lastSeen[n] = i;
  const t = hist.length;
  const omit = Array(50).fill(t);
  for (let n = 1; n <= 49; n++) omit[n] = lastSeen[n] < 0 ? t : (t - 1 - lastSeen[n]);

  const allNums = Array.from({ length: 49 }, (_, i) => i + 1);
  const hotRanked = allNums.slice().sort((a, b) =>
    hotFreq[b] - hotFreq[a] || omit[a] - omit[b] || a - b
  );
  const coldRanked = allNums.slice().sort((a, b) =>
    omit[b] - omit[a] || hotFreq[a] - hotFreq[b] || a - b
  );

  const hotPool = hotRanked.slice(0, HCR_HOT_POOL);
  const lastLabel = hist[hist.length - 1] ? hist[hist.length - 1].label : '';
  const seedStr = `${HCR_RULE_VERSION}|${targetLabel}|${limit}|${lastLabel}`;
  const seed = hashString(seedStr);
  const rng = mulberry32(seed);

  const pickedHot = deterministicPick(hotPool, HCR_PICK_HOT, rng).sort((a, b) => a - b);
  const selected = new Set(pickedHot);
  const coldPool = coldRanked.filter(n => !selected.has(n)).slice(0, HCR_COLD_POOL);
  const pickedCold = deterministicPick(coldPool, HCR_PICK_COLD, rng).sort((a, b) => a - b);
  for (const n of pickedCold) selected.add(n);
  const remainPool = allNums.filter(n => !selected.has(n));
  const pickedRandom = deterministicPick(remainPool, HCR_PICK_RANDOM, rng).sort((a, b) => a - b);
  const pick = pickedHot.concat(pickedCold, pickedRandom).sort((a, b) => a - b);

  return {
    ruleVersion: HCR_RULE_VERSION,
    targetLabel,
    historyCount: limit,
    lastLabel,
    seedStr,
    seed,
    hotWindow: HCR_HOT_WINDOW,
    hotPool,
    coldPool,
    pickedHot,
    pickedCold,
    pickedRandom,
    pick,
    hotFreq,
    omit
  };
}

// 兼容旧签名：P 表示使用 usableAsc 前 P 期作为历史，推荐目标为 year-periodNum
function run3in3At(usableAsc, P, year, periodNum, dateStr) {
  const label = `${year}-${String(periodNum).padStart(3, '0')}`;
  const effDate = dateStr || (P > 0 && usableAsc[P - 1] ? usableAsc[P - 1].date : periodToDate(year, periodNum));
  const trace = buildHcrTrace(usableAsc || [], P, label);
  if (!trace) {
    return {
      opt: [], method: HCR_RULE_VERSION, label, date: effDate, picks: [],
      normMeta: new Array(50), trace: null
    };
  }
  const opt = trace.pick.slice();
  const picks = opt.map(n => ({
    num: n,
    wave: WAVE_MAP[n],
    zodiac: zodiacOfNumber(n, effDate),
    role: trace.pickedHot.includes(n) ? 'hot' : trace.pickedCold.includes(n) ? 'cold' : 'random'
  }));
  return {
    opt,
    method: HCR_RULE_VERSION,
    label,
    date: effDate,
    picks,
    normMeta: picks.reduce((acc, p) => (acc[p.num] = { zodiac: p.zodiac, role: p.role }, acc), new Array(50)),
    trace: {
      ruleVersion: trace.ruleVersion,
      seed: trace.seed,
      seedStr: trace.seedStr,
      hotWindow: trace.hotWindow,
      hotPool: trace.hotPool,
      coldPool: trace.coldPool,
      pickedHot: trace.pickedHot,
      pickedCold: trace.pickedCold,
      pickedRandom: trace.pickedRandom
    }
  };
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


function zodiacOfNumber(num, dateStr) {
  return zodiacByBase(num, yearZodiacBaseIdx(dateStr));
}

if (typeof module !== 'undefined') module.exports = {
  run3in3At, buildHcrTrace,
  HCR_RULE_VERSION, HCR_HOT_WINDOW, HCR_HOT_POOL, HCR_COLD_POOL, HCR_PICK_HOT, HCR_PICK_COLD, HCR_PICK_RANDOM, HCR_MIN_HISTORY,
  hashString, mulberry32, deterministicPick,
  validSixNums, parseLabel, nextLabelOf,
  periodToDate, countTriples, buildAll35Triples,
  RANDOM_AVG_HITS, RANDOM_AVG_INTERVAL, RANDOM_WIN_RATE,
  pad2, escapeHtml, zoneOf, maxPeriodOfYear, zodiacOfNumber, yearZodiacBaseIdx, zodiacByBase,
  todayUTC, daysBetween,
  WAVE_MAP, WAVE_COLOR, ZODIACS, LUNAR_NEW_YEAR_DATES
};
