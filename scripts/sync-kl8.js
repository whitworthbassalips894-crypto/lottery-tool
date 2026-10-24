#!/usr/bin/env node
/**
 * 同步福彩快乐8开奖数据 → data/kl8-latest.json
 *
 * 特性：
 *  - Node 18+ 原生 fetch，零第三方依赖
 *  - 多源自动容灾：
 *      1) 中国福利彩票官网接口 findDrawNotice (name=kl8)
 *      2) GitHub 每日更新公开历史源兜底（应对 Actions 数据中心 IP 被官网拦截/403）
 *  - 兼容解析 CWL 官方 JSON、通用 JSON、HTML、Markdown、CSV 与纯文本
 *  - 严格校验每期记录：7位期号 YYYYNNN + 20 个不重复的 1–80 整数（升序规范化）
 *  - 增量合并全量历史，冲突保留已有记录并告警；无变化时不改写文件（changed=false）
 *
 * 用法：node scripts/sync-kl8.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CWL_URL = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=kl8&issueCount=&issueStart=&issueEnd=&dayStart=&dayEnd=&pageNo=1&pageSize=100&week=&systemType=PC';
const FALLBACK_URLS = [
  'https://raw.githubusercontent.com/ohbaby30/lotterydata/main/history/kl8.md',
  'https://raw.githubusercontent.com/aiyufan3/lucky_ball/main/data/kl8_history.json'
];
const OUT_FILE = path.resolve(__dirname, '..', 'data', 'kl8-latest.json');
const MAX_RECORDS = 5000;
const ATTEMPTS = 2;
const TIMEOUT_MS = 20000;

/* ==================== 通用期号与解析（与 index.html 内嵌解析器一致） ==================== */

function normalizeCode(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(20[2-9]\d)[-\s/._]?(\d{1,3})$/);
  if (!m) return '';
  const year = +m[1], period = +m[2];
  if (year < 2020 || year > 2100 || period < 1 || period > 366) return '';
  return `${year}${String(period).padStart(3, '0')}`;
}

function splitCode(code) {
  const clean = normalizeCode(code);
  if (!clean) return null;
  return { code: clean, year: +clean.slice(0, 4), period: +clean.slice(4) };
}

function normalizeDate(raw) {
  const m = String(raw ?? '').match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function validateNums(nums) {
  if (!Array.isArray(nums) || nums.length !== 20) return false;
  const seen = new Set();
  for (const x of nums) {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > 80 || seen.has(n)) return false;
    seen.add(n);
  }
  return true;
}

function validateRecord(r) {
  if (!r || typeof r !== 'object') return false;
  const info = splitCode(r.code || (r.year && r.period ? `${r.year}${String(r.period).padStart(3, '0')}` : ''));
  if (!info) return false;
  return validateNums(r.nums);
}

function stripHtml(raw) {
  let s = String(raw == null ? '' : raw);
  if (s.indexOf('<') === -1) return s;
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
       .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n')
       .replace(/<\/(p|div|tr|li|h[1-6]|section|article|table)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } });
  s = s.replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch (e) { return ' '; } });
  s = s.replace(/&nbsp;|&ensp;|&emsp;/gi, ' ')
       .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  return s;
}

/** 尝试按 JSON 解析（支持福彩官网 findDrawNotice、仓库 kl8-latest.json、通用数组） */
function tryParseJson(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data.result)
      ? data.result
      : Array.isArray(data.records)
        ? data.records
        : Array.isArray(data.data)
          ? data.data
          : Array.isArray(data.list)
            ? data.list
            : null;
  if (!arr) return null;

  const records = [];
  const errors = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    const rawCode = item.code || item.issue || item.issueno || item.periodLabel || item.label ||
      (item.year && item.period ? `${item.year}${String(item.period).padStart(3, '0')}` : '');
    const info = splitCode(rawCode);
    if (!info) {
      errors.push(`JSON 第 ${i + 1} 项期号无效：${rawCode}`);
      continue;
    }
    const rawNums = item.nums || item.numbers || item.red || item.openCode || item.number || item.result;
    let nums = [];
    if (Array.isArray(rawNums)) {
      nums = rawNums.map(Number);
    } else if (typeof rawNums === 'string') {
      nums = (rawNums.match(/\d{1,2}/g) || []).map(Number);
    }
    if (!validateNums(nums)) {
      errors.push(`期 ${info.code}：号码不是 20 个不重复的 1–80 整数，已跳过`);
      continue;
    }
    records.push({
      code: info.code,
      year: info.year,
      period: info.period,
      date: normalizeDate(item.date || item.openDate || item.opendate || item.drawDate || ''),
      nums: nums.slice().sort((a, b) => a - b)
    });
  }
  return { records, errors };
}

/** 找出文本中所有期号头：支持 2026282 / 2026-282 / 第2026282期 / 282期(2026-10-23) */
function collectHeaders(text) {
  const list = [];
  let m;
  // 1) 明确带年份的 7位期号或 YYYY-NNN 期号（排除日期 YYYY-MM-DD 和 8位数字串）
  const reFull = /(?<!\d)(?:第\s*)?(20[2-9]\d)(?:[-—·~／/])?(\d{3})(?!\d)(?!\s*[-/.]\d)\s*期?/g;
  while ((m = reFull.exec(text))) {
    const year = +m[1], period = +m[2];
    if (period >= 1 && period <= 366) {
      list.push({ idx: m.index, end: m.index + m[0].length, year, period });
    }
  }
  // 2) 仅写 “第 282 期” / “282 期”
  const reShort = /(?<!\d)(?:第\s*)?(\d{1,3})\s*期/g;
  while ((m = reShort.exec(text))) {
    const period = +m[1];
    if (period >= 1 && period <= 366) {
      list.push({ idx: m.index, end: m.index + m[0].length, year: null, period });
    }
  }
  list.sort((a, b) => a.idx - b.idx || b.end - a.end);
  const out = [];
  for (const h of list) {
    const prev = out[out.length - 1];
    if (prev && h.idx < prev.end) continue;
    out.push(h);
  }
  return out;
}

/** 从期号头之后的片段提取前 20 个 1–80 号码 */
function numsFromBody(body) {
  let b = String(body || '');
  b = b.replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, ' ');
  b = b.replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ');
  b = b.replace(/[\d,.]+\s*(?:亿元|万元|元|注|倍)/g, ' ');
  b = b.replace(/\d{3,}/g, ' ');
  const tokens = b.match(/\d{1,2}/g) || [];
  const nums = [];
  for (const t of tokens) {
    const n = +t;
    if (n >= 1 && n <= 80) {
      nums.push(n);
      if (nums.length === 20) break;
    }
  }
  return nums;
}

/** 主解析入口：兼容 JSON / HTML / Markdown / CSV / 纯文本 */
function parseDrawText(raw) {
  const jsonAttempt = tryParseJson(raw);
  if (jsonAttempt) return jsonAttempt;

  const errors = [];
  const records = [];
  const text = stripHtml(raw).replace(/\r\n?/g, '\n');
  const headers = collectHeaders(text);
  if (!headers.length) {
    errors.push('未识别到任何快乐8期号（示例：2026282、2026-282 或 第2026282期）');
    return { records, errors };
  }

  const pending = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const body = text.slice(h.end, i + 1 < headers.length ? headers[i + 1].idx : undefined);
    const date = normalizeDate(body);
    const nums = numsFromBody(body);
    if (nums.length < 20) {
      errors.push(`期 ${h.year || ''}${String(h.period).padStart(3, '0')}：仅解析到 ${nums.length}/20 个号码，已跳过`);
      continue;
    }
    if (new Set(nums).size < 20) {
      errors.push(`期 ${h.year || ''}${String(h.period).padStart(3, '0')}：号码存在重复，已跳过`);
      continue;
    }
    pending.push({ year: h.year, period: h.period, date, nums: nums.slice().sort((a, b) => a - b) });
  }

  let prevYear = null, prevPeriod = null;
  for (const r of pending) {
    if (!r.year) {
      if (r.date) r.year = +r.date.slice(0, 4);
      else if (prevYear != null) r.year = (prevPeriod != null && r.period < prevPeriod) ? prevYear + 1 : prevYear;
    }
    prevYear = r.year;
    prevPeriod = r.period;
  }

  for (const r of pending) {
    if (!r.year || r.year < 2020 || r.year > 2100) {
      errors.push(`期 ${r.period}：无法确定年份，已跳过`);
      continue;
    }
    if (r.period < 1 || r.period > 366) {
      errors.push(`期 ${r.period}：超出合理期号范围，已跳过`);
      continue;
    }
    const code = `${r.year}${String(r.period).padStart(3, '0')}`;
    records.push({
      code,
      year: r.year,
      period: r.period,
      date: r.date || '',
      nums: r.nums
    });
  }
  return { records, errors };
}

/** 合并旧记录与新记录（按 code 升序；同期号码不同视为冲突，保留已有值） */
function mergeRecords(oldRecords, newRecords) {
  const map = new Map();
  let conflicts = 0, added = 0;

  for (const r of (oldRecords || [])) {
    if (!validateRecord(r)) continue;
    const info = splitCode(r.code || `${r.year}${String(r.period).padStart(3, '0')}`);
    map.set(info.code, {
      code: info.code,
      year: info.year,
      period: info.period,
      date: normalizeDate(r.date) || '',
      nums: r.nums.map(Number).sort((a, b) => a - b)
    });
  }

  for (const r of (newRecords || [])) {
    if (!validateRecord(r)) continue;
    const info = splitCode(r.code || `${r.year}${String(r.period).padStart(3, '0')}`);
    const nums = r.nums.map(Number).sort((a, b) => a - b);
    const date = normalizeDate(r.date) || '';
    const old = map.get(info.code);
    if (!old) {
      map.set(info.code, { code: info.code, year: info.year, period: info.period, date, nums });
      added++;
      continue;
    }
    const same = old.nums.length === nums.length && old.nums.every((n, i) => n === nums[i]);
    if (same) {
      if (!old.date && date) old.date = date;
      continue;
    }
    conflicts++;
    console.warn(`[warn] 期号 ${info.code} 号码冲突（保留已有值）：已有 [${old.nums}] vs 新抓取 [${nums}]`);
  }

  const records = [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  return { records, conflicts, added };
}

function buildDataObject(records, updatedAt, sourceUrl) {
  const trimmed = records.slice(-MAX_RECORDS);
  const last = trimmed[trimmed.length - 1];
  return {
    source: sourceUrl || 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=kl8',
    updatedAt,
    year: last ? last.year : new Date().getFullYear(),
    latestCode: last ? last.code : '',
    latestDate: last ? last.date : '',
    latestLabel: last ? `KL8-${last.code}` : '',
    records: trimmed
  };
}

/** 紧凑稳定 JSON：nums 单行输出，大幅减小体积并让 git diff 清晰可读 */
function canonicalize(obj) {
  const head = {
    source: obj.source,
    updatedAt: obj.updatedAt,
    year: obj.year,
    latestCode: obj.latestCode,
    latestDate: obj.latestDate || '',
    latestLabel: obj.latestLabel || (obj.latestCode ? `KL8-${obj.latestCode}` : '')
  };
  const lines = [
    '{',
    `  "source": ${JSON.stringify(head.source)},`,
    `  "updatedAt": ${JSON.stringify(head.updatedAt)},`,
    `  "year": ${JSON.stringify(head.year)},`,
    `  "latestCode": ${JSON.stringify(head.latestCode)},`,
    `  "latestDate": ${JSON.stringify(head.latestDate)},`,
    `  "latestLabel": ${JSON.stringify(head.latestLabel)},`,
    '  "records": ['
  ];
  const recs = obj.records || [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const comma = i + 1 < recs.length ? ',' : '';
    lines.push(
      `    {"code":${JSON.stringify(r.code)},"year":${r.year},"period":${r.period},"date":${JSON.stringify(r.date || '')},"nums":[${r.nums.join(',')}]}${comma}`
    );
  }
  lines.push('  ]', '}');
  return lines.join('\n') + '\n';
}

/* ==================== 网络抓取（多源容灾） ==================== */

async function fetchWithTimeout(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } catch (e) {
    clearTimeout(timer);
    throw (e && e.name === 'AbortError') ? new Error(`超时（>${TIMEOUT_MS}ms）`) : e;
  }
}

async function fetchCwlOfficial(url) {
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.cwl.gov.cn/',
    'X-Requested-With': 'XMLHttpRequest',
    'Cache-Control': 'no-cache'
  };
  // 先直接请求；若官网要求先种 Cookie，则先访问首页获取 Set-Cookie 后重试
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: baseHeaders, signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(timer);
    if (res.status === 200) {
      const txt = await res.text();
      if (txt.trim().startsWith('{')) return txt;
    }
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookieHeader = setCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
    if (cookieHeader) {
      return await fetchWithTimeout(url, { ...baseHeaders, Cookie: cookieHeader });
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function fetchFromSources() {
  const custom = process.env.SYNC_SOURCE_URL;
  const candidates = custom
    ? [{ name: '自定义源', url: custom, official: custom.includes('cwl.gov.cn') }]
    : [
        { name: '中国福彩官网接口', url: CWL_URL, official: true },
        { name: 'GitHub 公开历史镜像 #1', url: FALLBACK_URLS[0], official: false },
        { name: 'GitHub 公开历史镜像 #2', url: FALLBACK_URLS[1], official: false }
      ];

  const errs = [];
  for (const src of candidates) {
    for (let i = 1; i <= ATTEMPTS; i++) {
      try {
        console.log(`[info] 尝试 ${src.name} (${src.url}) 第 ${i}/${ATTEMPTS} 次...`);
        const raw = src.official
          ? await fetchCwlOfficial(src.url)
          : await fetchWithTimeout(src.url, {
              'User-Agent': 'Mozilla/5.0 (compatible; kl8-sync/1.0)',
              'Accept': 'text/plain,application/json,*/*'
            });
        const parsed = parseDrawText(raw);
        if (parsed.records.length > 0) {
          console.log(`[ok] ${src.name} 解析成功：获得 ${parsed.records.length} 期记录（最新 ${parsed.records[parsed.records.length - 1].code} 或 ${parsed.records[0].code}）`);
          return { raw, parsed, sourceUrl: src.official ? 'https://www.cwl.gov.cn/ygkj/wqkjgg/kl8/' : src.url };
        }
        throw new Error('响应成功但解析出 0 条快乐8记录');
      } catch (e) {
        const msg = `${src.name}(#${i}): ${e && e.message || e}`;
        console.warn(`[warn] ${msg}`);
        errs.push(msg);
        if (i < ATTEMPTS) await new Promise(r => setTimeout(r, 2000 * i));
      }
    }
  }
  throw new Error(errs.join(' | '));
}

function setGithubOutput(k, v) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  try { fs.appendFileSync(f, `${k}=${v}\n`); } catch (e) { /* ignore */ }
}

async function main() {
  let fetched;
  try {
    fetched = await fetchFromSources();
  } catch (e) {
    console.error('==============================================================');
    console.error(`::error::抓取快乐8开奖数据失败：${e.message}`);
    console.error(`::error::已保留原有 ${path.relative(process.cwd(), OUT_FILE)}，未被改动。`);
    console.error('==============================================================');
    setGithubOutput('changed', 'false');
    process.exit(2);
  }

  const { records: parsed, errors } = fetched.parsed;
  for (const msg of errors.slice(0, 8)) console.warn(`[warn] 解析提示：${msg}`);
  if (!parsed.length) {
    console.error('::error::解析到 0 条有效快乐8开奖记录，原文件保持不变。');
    setGithubOutput('changed', 'false');
    process.exit(3);
  }

  let oldRecords = [], oldUpdatedAt = null, oldSource = null;
  try {
    const oldJson = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    oldRecords = Array.isArray(oldJson.records) ? oldJson.records : [];
    oldUpdatedAt = oldJson.updatedAt || null;
    oldSource = oldJson.source || null;
  } catch (e) { /* 首次生成 */ }

  const { records, conflicts, added } = mergeRecords(oldRecords, parsed);
  const prevProbe = canonicalize(buildDataObject(oldRecords, 'X', 'S'));
  const nextProbe = canonicalize(buildDataObject(records, 'X', 'S'));
  const recordsChanged = prevProbe !== nextProbe;

  const updatedAt = recordsChanged ? new Date().toISOString() : (oldUpdatedAt || new Date().toISOString());
  const sourceUrl = recordsChanged ? fetched.sourceUrl : (oldSource || fetched.sourceUrl);
  const outObj = buildDataObject(records, updatedAt, sourceUrl);
  const outStr = canonicalize(outObj);

  let oldRaw = null;
  try { oldRaw = fs.readFileSync(OUT_FILE, 'utf8'); } catch (e) {}

  if (!recordsChanged && oldRaw === outStr) {
    console.log(`[ok] 数据无变化，共 ${records.length} 期（${records[0].code} ~ ${outObj.latestCode}），跳过写入。`);
    setGithubOutput('changed', 'false');
    setGithubOutput('latest', outObj.latestCode);
    return { changed: false, outObj, outFile: OUT_FILE };
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, outStr, 'utf8');
  fs.renameSync(tmp, OUT_FILE);

  console.log(`[ok] 已更新 ${OUT_FILE}`);
  console.log(`[ok] 共 ${records.length} 期（${records[0].code} ~ ${outObj.latestCode}），新增 ${added} 期，冲突 ${conflicts} 期。`);
  setGithubOutput('changed', recordsChanged ? 'true' : 'false');
  setGithubOutput('latest', outObj.latestCode);
  return { changed: recordsChanged, outObj, outFile: OUT_FILE };
}

module.exports = {
  main,
  normalizeCode,
  splitCode,
  normalizeDate,
  validateNums,
  validateRecord,
  stripHtml,
  collectHeaders,
  numsFromBody,
  parseDrawText,
  mergeRecords,
  buildDataObject,
  canonicalize
};

if (require.main === module) {
  main().catch(e => {
    console.error(`::error::${e && e.message || e}`);
    process.exit(1);
  });
}
