#!/usr/bin/env node
/**
 * 同步澳门六合彩开奖数据 → data/am-latest.json
 *
 * 特性：
 *  - Node 18+ 原生 fetch，无第三方依赖
 *  - 抓取 https://2026kj.zkclhb.com:2025/am.html （带常见浏览器 headers + 重试）
 *  - 解析期号 / 开奖日期 / 7 个号码，兼容 HTML、纯文本、Markdown
 *  - 记录按期号升序、去重；每期校验：7 个不重复的 1-49 整数
 *  - 保留全量历史记录（不只最新一期），与新解析结果合并
 *  - 无变化时不改写文件、不报错（GITHUB_OUTPUT changed=false）
 *  - 抓取/解析失败时：清晰输出错误、保持已有 JSON 不变（exit 2/3）
 *
 * 用法：node scripts/sync-am.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_URL = process.env.SYNC_SOURCE_URL || 'https://2026kj.zkclhb.com:2025/am.html';
const OUT_FILE = path.resolve(__dirname, '..', 'data', 'am-latest.json');
const MAX_RECORDS = 5000;
const ATTEMPTS = 3;
const TIMEOUT_MS = 20000;

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://2026kj.zkclhb.com:2025/',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1'
};

/* ==================== 通用解析（与 index.html 内嵌解析器保持一致） ==================== */

function leap(y) { return y % 4 === 0 && y % 100 !== 0 || y % 400 === 0; }
function maxPeriodOf(y) { return leap(y) ? 366 : 365; }

/** HTML → 纯文本（剥标签、解码常见实体）；纯文本原样返回 */
function stripHtml(raw) {
  let s = String(raw == null ? '' : raw);
  if (s.indexOf('<') === -1) return s;
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
       .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n')
       .replace(/<\/(p|div|tr|li|h[1-6]|section|article|table)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } });
  s = s.replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(+d); } catch (e) { return ' '; } });
  s = s.replace(/&nbsp;|&ensp;|&emsp;/gi, ' ')
       .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  return s;
}

/** 找出所有期号头：支持 “242 期(开奖时间:2026-08-30)” / “第242期” / “2026-242” */
function collectHeaders(text) {
  const list = [];
  let m;
  const reA = /(?:第\s*)?(\d{4})?\s*[-—·~／/]?\s*(\d{1,3})\s*期/g;
  while ((m = reA.exec(text))) {
    const period = +m[2];
    if (period >= 1 && period <= 366) list.push({ idx: m.index, end: m.index + m[0].length, year: m[1] ? +m[1] : null, period });
  }
  const reB = /(\d{4})-(\d{1,3})(?![\d])(?!\s*[-/.]\d)/g;
  while ((m = reB.exec(text))) {
    const period = +m[2];
    if (period >= 1 && period <= 366) list.push({ idx: m.index, end: m.index + m[0].length, year: +m[1], period });
  }
  list.sort((a, b) => a.idx - b.idx || b.end - a.end);
  const out = [];
  for (const h of list) {
    const prev = out[out.length - 1];
    if (prev && h.idx < prev.end) continue; // 与更早的头部重叠 → 丢弃
    out.push(h);
  }
  return out;
}

/** 从一段“期号之后”的文本里按顺序取前 7 个 1-49 的号码 */
function numsFromBody(body) {
  let b = String(body || '');
  b = b.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' '); // 日期
  b = b.replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ');        // 时间
  b = b.replace(/\d{3,}/g, ' ');                        // 3 位以上数字串
  const tokens = b.match(/\d{1,2}/g) || [];
  const nums = [];
  for (const t of tokens) {
    const n = +t;
    if (n >= 1 && n <= 49) { nums.push(n); if (nums.length === 7) break; }
  }
  return nums;
}

/** 主解析入口：返回 {records:[{label,year,period,date,nums,special}], errors:[...]} */
function parseDrawText(raw) {
  const errors = [];
  const records = [];
  let text = stripHtml(raw).replace(/\r\n?/g, '\n');
  const headers = collectHeaders(text);
  if (!headers.length) {
    errors.push('未识别到任何期号（需要类似 “242 期(开奖时间:2026-08-30)” 或 “2026-242” 的期号行）');
    return { records, errors };
  }
  const pending = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const body = text.slice(h.end, i + 1 < headers.length ? headers[i + 1].idx : undefined);
    let date = '';
    const dm = body.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (dm) date = `${dm[1]}-${String(+dm[2]).padStart(2, '0')}-${String(+dm[3]).padStart(2, '0')}`;
    const nums = numsFromBody(body);
    if (nums.length < 7) { errors.push(`期 ${h.period}：只解析到 ${nums.length} 个号码，已跳过`); continue; }
    if (new Set(nums).size < 7) { errors.push(`期 ${h.period}：号码出现重复，已跳过`); continue; }
    pending.push({ year: h.year, period: h.period, date, nums });
  }
  // 年份推断：期号自带 > 开奖日期 > 相邻期跨年推断
  let prevYear = null, prevPeriod = null;
  for (const r of pending) {
    if (!r.year) {
      if (r.date) r.year = +r.date.slice(0, 4);
      else if (prevYear != null) r.year = (prevPeriod != null && r.period < prevPeriod) ? prevYear + 1 : prevYear;
    }
    prevYear = r.year; prevPeriod = r.period;
  }
  for (const r of pending) {
    if (!r.year || r.year < 2000 || r.year > 2100) { errors.push(`期 ${r.period}：无法确定年份，已跳过`); continue; }
    if (r.period < 1 || r.period > maxPeriodOf(r.year)) { errors.push(`期 ${r.period}：超出 ${r.year} 年期号范围，已跳过`); continue; }
    records.push({
      label: `${r.year}-${String(r.period).padStart(3, '0')}`,
      year: r.year,
      period: r.period,
      date: r.date || '',
      nums: r.nums.slice(),
      special: r.nums[6]
    });
  }
  return { records, errors };
}

/** 校验一条记录：7 个不重复的 1-49 整数 */
function validateRecord(r) {
  return !!r && Array.isArray(r.nums) && r.nums.length === 7 &&
    r.nums.every(n => Number.isInteger(+n) && +n >= 1 && +n <= 49) &&
    new Set(r.nums.map(Number)).size === 7 &&
    Number.isInteger(+r.period) && +r.period >= 1 && +r.period <= maxPeriodOf(+r.year) &&
    !!r.label && !!r.year;
}

/** 按年份 + 期号推算日期（期号即年内第 N 天） */
function dateFromDay(year, day) {
  const d = new Date(Date.UTC(year, 0, day));
  return d.toISOString().slice(0, 10);
}

/** 规范化记录数组：排序 + 去重（同 label 号码不同视为冲突，保留旧值） */
function mergeRecords(oldRecords, newRecords) {
  const map = new Map();
  let conflicts = 0, added = 0;
  for (const r of (oldRecords || [])) {
    if (validateRecord(r)) map.set(r.label, { label: r.label, year: +r.year, period: +r.period, date: r.date || '', nums: r.nums.map(Number), special: +r.nums[6] });
  }
  for (const r of (newRecords || [])) {
    const rec = { label: r.label, year: +r.year, period: +r.period, date: r.date || '', nums: r.nums.map(Number), special: +r.nums[6] };
    const old = map.get(rec.label);
    if (!old) { map.set(rec.label, rec); added++; continue; }
    const same = old.nums.length === rec.nums.length && old.nums.every((n, i) => n === rec.nums[i]);
    if (same) { if (!old.date && rec.date) old.date = rec.date; continue; }
    conflicts++;
    console.warn(`[warn] 期号 ${rec.label} 与已有记录号码不同（保留已有值）：已有 [${old.nums}] vs 新抓取 [${rec.nums}]`);
  }
  const records = [...map.values()].sort((a, b) => a.year - b.year || a.period - b.period);
  return { records, conflicts, added };
}

/** 构建最终 JSON 对象（字段顺序固定，便于稳定 diff） */
function buildDataObject(records, updatedAt) {
  const trimmed = records.slice(-MAX_RECORDS);
  const last = trimmed[trimmed.length - 1];
  return {
    source: SOURCE_URL,
    updatedAt,
    year: last ? last.year : new Date().getFullYear(),
    latestLabel: last ? last.label : '',
    records: trimmed
  };
}
function canonicalize(obj) { return JSON.stringify(obj, null, 2) + '\n'; }

/* ==================== 抓取 ==================== */

async function fetchSource() {
  let lastErr = '';
  for (let i = 1; i <= ATTEMPTS; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      console.log(`[info] 抓取 ${SOURCE_URL}（第 ${i}/${ATTEMPTS} 次）...`);
      const res = await fetch(SOURCE_URL, { headers: REQUEST_HEADERS, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = `HTTP ${res.status} ${res.statusText}`;
        console.error(`[error] 第 ${i} 次失败：${lastErr}`);
        if (res.status === 403) {
          console.error('[error] 源站返回 403：很可能屏蔽了数据中心 IP 或非浏览器客户端（Cloudflare 拦截）。');
        }
      } else {
        return await res.text();
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = (e && e.name === 'AbortError') ? `超时（>${TIMEOUT_MS}ms）` : (e && e.message) || String(e);
      console.error(`[error] 第 ${i} 次失败：${lastErr}`);
    }
    if (i < ATTEMPTS) await new Promise(r => setTimeout(r, 3000 * i));
  }
  throw new Error(lastErr || '未知网络错误');
}

/* ==================== 输出与主流程 ==================== */

function setGithubOutput(k, v) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  try { fs.appendFileSync(f, `${k}=${v}\n`); } catch (e) { /* ignore */ }
}

async function main() {
  let html;
  try {
    html = await fetchSource();
  } catch (e) {
    console.error('==============================================================');
    console.error(`::error::抓取源站失败：${e.message}`);
    console.error(`::error::已保留原有 ${path.relative(process.cwd(), OUT_FILE)}，未被改动。`);
    console.error('排查建议：');
    console.error(' 1) 本地浏览器打开源站确认是否可访问（若浏览器也 403/打不开，说明源站异常）；');
    console.error(' 2) 源站若屏蔽 GitHub Actions IP，可改用工具页面里的“粘贴导入”兜底；');
    console.error(' 3) 也可手动在本地运行 node scripts/sync-am.js（家庭宽带 IP 通常可访问）。');
    console.error('==============================================================');
    setGithubOutput('changed', 'false');
    process.exit(2);
  }

  const { records: parsed, errors } = parseDrawText(html);
  for (const msg of errors.slice(0, 10)) console.warn(`[warn] 解析：${msg}`);
  if (errors.length > 10) console.warn(`[warn] 解析：另有 ${errors.length - 10} 条警告省略`);
  if (!parsed.length) {
    console.error('==============================================================');
    console.error('::error::抓取成功，但解析到 0 条有效开奖记录。源站页面结构可能已变化。');
    console.error(`::error::已保留原有 ${path.relative(process.cwd(), OUT_FILE)}，未被改动。`);
    console.error('==============================================================');
    setGithubOutput('changed', 'false');
    process.exit(3);
  }

  let oldRecords = null, oldUpdatedAt = null;
  try {
    const oldRaw = fs.readFileSync(OUT_FILE, 'utf8');
    const oldJson = JSON.parse(oldRaw);
    oldRecords = Array.isArray(oldJson.records) ? oldJson.records : [];
    oldUpdatedAt = oldJson.updatedAt || null;
  } catch (e) { /* 文件不存在或损坏 → 视为全新生成 */ }

  const { records, conflicts, added } = mergeRecords(oldRecords, parsed);
  const recordsChanged = canonicalize(buildDataObject(records, 'X')) !== canonicalize(buildDataObject(oldRecords || [], 'X'));

  // 无变化时保持 updatedAt 不变，从而保证文件字节级一致（不产生 commit）
  const updatedAt = recordsChanged ? new Date().toISOString() : (oldUpdatedAt || new Date().toISOString());
  const outObj = buildDataObject(records, updatedAt);
  const outStr = canonicalize(outObj);

  const oldStr = (() => { try { return canonicalize(JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))); } catch (e) { return null; } })();

  if (oldStr === outStr) {
    console.log(`[ok] 数据无变化，共 ${records.length} 期（${records[0].label} ~ ${records[records.length - 1].label}），不写入文件。`);
    setGithubOutput('changed', 'false');
    setGithubOutput('latest', records[records.length - 1].label);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, outStr, 'utf8');
  fs.renameSync(tmp, OUT_FILE);

  console.log(`[ok] 已写入 ${OUT_FILE}`);
  console.log(`[ok] 共 ${records.length} 期（${records[0].label} ~ ${records[records.length - 1].label}），新增 ${added} 期，冲突 ${conflicts} 期（冲突保留已有值）。`);
  console.log(`[ok] 最新一期：${outObj.latestLabel}（updatedAt=${outObj.updatedAt}）`);
  setGithubOutput('changed', 'true');
  setGithubOutput('latest', outObj.latestLabel);
}

module.exports = { stripHtml, collectHeaders, numsFromBody, parseDrawText, validateRecord, mergeRecords, buildDataObject, canonicalize, dateFromDay, maxPeriodOf };

if (require.main === module) main().catch(e => { console.error(`::error::${e && e.message || e}`); process.exit(1); });
