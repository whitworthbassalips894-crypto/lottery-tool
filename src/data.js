'use strict';
if (typeof module !== 'undefined') Object.assign(globalThis, require('./engine.js'));
// 口径：前 6 个平码用于三中三选号与命中核对；第 7 位特码只单独记录、单独统计命中，
// 任何时候都不进入 run3in3At 的评分，因此加入特码不会改变既有 7 码方案。
const UNIT_STAKE = 2, PAYOUT_MULTIPLIER = 700, GROUPS_PER_PLAN = 35;
const COST_PER_PERIOD = UNIT_STAKE * GROUPS_PER_PLAN;
const PRIZE_PER_GROUP = UNIT_STAKE * PAYOUT_MULTIPLIER;
// 特码只做命中记录，不模拟金额；随机基线 = 7 / 49。
const SPECIAL_BASELINE_RATE = 7 / 49 * 100;
const SPECIAL_RECENT_WINDOW = 20;
const STORAGE_SCHEMA = 2;

function normalizeSpecial(value) {
  return Number.isInteger(value) && value >= 1 && value <= 49 ? value : null;
}
function sameSix(a, b) {
  return a.slice().sort((x, y) => x - y).join(',') === b.slice().sort((x, y) => x - y).join(',');
}
function normalizeSource(source) {
  if (!source || !Array.isArray(source.draws) || !source.draws.length || source.draws.length > 10000) throw new Error('数据源缺少有效开奖记录');
  const map = new Map(), invalid = [];
  for (const item of source.draws) {
    const p = parseLabel(item && item.id);
    if (!p) throw new Error('数据源存在无效期号');
    const numbers = item.numbers;
    if (!validSixNums(numbers)) { invalid.push(p.label); continue; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(item.date || '') ? item.date : periodToDate(p.year, p.periodNum);
    const rec = { ...p, date, numbers: numbers.slice(), special: normalizeSpecial(item && item.special) };
    // 手动补录标记随本机备份一起保存，撤销时才认得出哪一期是手动写入的。
    if (item && item.manual === true) rec.manual = true;
    if (map.has(p.label)) throw new Error('数据源存在重复期号 ' + p.label);
    map.set(p.label, rec);
  }
  const records = [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  if (!records.length) throw new Error('数据源没有有效的前6码');
  const latest = parseLabel(source.latestId);
  if (latest && invalid.includes(latest.label)) throw new Error('数据源最新一期前6码无效：' + latest.label);
  if (latest && latest.label !== records.at(-1).label) throw new Error('数据源最新期号与记录不一致');
  return { records, invalid, updatedAt: source.updatedAt || '' };
}
function mergeSource(current, source) {
  const next = normalizeSource(source);
  if (!current.length) throw new Error('本地没有可核对的基准记录');
  if (next.records.at(-1).label < current.at(-1).label) throw new Error('来源数据最新期 ' + next.records.at(-1).label + ' 落后于当前记录 ' + current.at(-1).label + '，未写入');
  const old = new Map(current.map(r => [r.label, r]));
  for (const r of next.records) {
    const previous = old.get(r.label);
    if (!previous) continue;
    if (!sameSix(previous.numbers, r.numbers)) throw new Error('期号 ' + r.label + ' 与本地记录冲突，未写入；请核对数据源');
    if (previous.special != null && r.special != null && previous.special !== r.special) {
      throw new Error('期号 ' + r.label + ' 特码冲突（本地 ' + pad2(previous.special) + '，来源 ' + pad2(r.special) + '），未写入；请核对开奖');
    }
  }
  const incoming = new Map(next.records.map(r => [r.label, r]));
  let specialFilled = 0, confirmed = 0;
  // 只做补全，不改写已有平码：旧版本机数据没有特码，来源补齐后回填；
  // 手动补录的期号一旦被来源收录（号码一致），就不再算手动记录。
  const base = current.map(previous => {
    const r = incoming.get(previous.label);
    if (!r) return previous;
    const updated = { ...previous };
    let changed = false;
    if (previous.special == null && r.special != null) { updated.special = r.special; specialFilled++; changed = true; }
    if (previous.manual && !r.manual) { delete updated.manual; confirmed++; changed = true; }
    return changed ? updated : previous;
  });
  let last = base.at(-1).label;
  const additions = next.records.filter(r => r.label > last);
  for (const r of additions) {
    const expected = nextLabelOf(last);
    if (r.label !== expected) throw new Error('数据源存在缺口：需要 ' + expected + '，未写入');
    last = r.label;
  }
  return { records: base.concat(additions), invalid: next.invalid, added: additions.length, specialFilled, confirmed, updatedAt: next.updatedAt };
}
// 打开页面时把「本机备份」并回「内置快照」。
// 与 mergeSource 的区别：这里两边谁新谁旧都可能发生——站点更新了内置快照（本机备份变旧）、
// 或本机同步过更新的数据（内置快照变旧），两种情况都要能合，不能直接报错。
// 合并口径：两边共有的期号必须一致（平码、特码冲突照旧拒绝），特码与手动标记以信息更全的一边为准，
// 超出内置快照的期次按连续期号追加；本机备份被内置快照收录的手动记录视为已确认。
function mergeLocal(builtin, saved) {
  if (!Array.isArray(builtin) || !builtin.length) throw new Error('内置数据为空，无法核对本机备份');
  const backup = normalizeSource(saved);
  const official = new Map(builtin.map(r => [r.label, r]));
  const savedMap = new Map(backup.records.map(r => [r.label, r]));
  const conflicts = [];
  let specialFilled = 0, manualKept = 0, manualConfirmed = 0, manualDropped = 0;
  const base = builtin.map(previous => {
    const r = savedMap.get(previous.label);
    if (!r) return previous;
    // 两边都有这一期：以官方（内置快照）为准，只补特码；本机手动补录此时已得到官方确认。
    const sixSame = sameSix(previous.numbers, r.numbers);
    const specialFight = previous.special != null && r.special != null && previous.special !== r.special;
    if (r.manual) { if (sixSame && !specialFight) manualConfirmed++; else manualDropped++; }
    if (!sixSame) conflicts.push(`期号 ${previous.label} 的手动补录与官方开奖号码不一致，已按官方数据计`);
    if (specialFight) conflicts.push(`期号 ${previous.label} 特码不一致（本机 ${pad2(r.special)} / 官方 ${pad2(previous.special)}），已按官方数据计`);
    const updated = { ...previous };
    let changed = false;
    if (previous.special == null && r.special != null && sixSame) { updated.special = r.special; specialFilled++; changed = true; }
    return changed ? updated : previous;
  });
  let last = base.at(-1).label;
  const additions = [];
  for (const r of backup.records.filter(r => r.label > last)) {
    const expected = nextLabelOf(last);
    if (r.label !== expected) throw new Error('本机备份存在缺口：需要 ' + expected + '，未采用本机备份');
    additions.push(r);
    last = r.label;
  }
  for (const r of additions) if (r.manual) manualKept++;
  return {
    records: base.concat(additions), invalid: backup.invalid, conflicts,
    added: additions.length, manualKept, manualConfirmed, manualDropped, specialFilled
  };
}
function buildReplay(records) {
  return records.flatMap((r, i) => {
    const plan = run3in3At(records, i, r.year, r.periodNum, r.date);
    // 固定 7 码总能给出 7 码；仍保留兜底，避免把不足 7 码伪装成复式方案。
    if (plan.opt.length !== 7) return [];
    const actual = new Set(r.numbers), hits = plan.opt.filter(n => actual.has(n));
    const triples = countTriples(hits.length);
    const special = r.special == null ? null : r.special;
    return [{
      ...r, recommended: plan.opt, hits, triples,
      cost: COST_PER_PERIOD, prize: triples * PRIZE_PER_GROUP,
      special, specialHit: special == null ? null : plan.opt.includes(special)
    }];
  });
}
function summarizeReplay(rows) {
  const periods = rows.length;
  const winningPeriods = rows.filter(r => r.triples > 0).length;
  const groups = rows.reduce((total, r) => total + r.triples, 0);
  const cost = periods * COST_PER_PERIOD, prize = groups * PRIZE_PER_GROUP;
  return { periods, winningPeriods, groups, cost, prize, net: prize - cost,
    winningRate: periods ? winningPeriods / periods * 100 : 0,
    returnRate: cost ? prize / cost * 100 : 0,
    // 平均每期命中平码数：低于随机 7 码的 0.857 才说明「命中率最低」策略确实成立
    avgHits: periods ? rows.reduce((total, r) => total + (r.hits ? r.hits.length : 0), 0) / periods : 0,
    baselineAvgHits: 7 * 6 / 49,
    baselineWinningRate: 3.0951780258 };
}
// 特码命中：当期主推 7 码里是否包含开奖第 7 位特码。只记录命中与命中率，不折算金额。
function summarizeSpecial(rows) {
  const known = rows.filter(r => r.special != null);
  const periods = known.length;
  const wins = known.filter(r => r.specialHit).length;
  let currentMiss = 0;
  for (let i = periods - 1; i >= 0; i--) { if (known[i].specialHit) break; currentMiss++; }
  let maxMiss = 0, run = 0;
  for (const r of known) { if (r.specialHit) run = 0; else { run++; if (run > maxMiss) maxMiss = run; } }
  const recent = known.slice(-SPECIAL_RECENT_WINDOW);
  return {
    periods, unknown: rows.length - periods, wins, misses: periods - wins,
    rate: periods ? wins / periods * 100 : 0,
    baseline: SPECIAL_BASELINE_RATE,
    interval: wins ? periods / wins : null,
    currentMiss, maxMiss,
    recentPeriods: recent.length,
    recentWins: recent.filter(r => r.specialHit).length
  };
}
// 粘贴解析口径与参考工具一致：按 1~2 位数字切块，只保留 1~49。
function parsePastedNumbers(text) {
  const chunks = String(text == null ? '' : text).match(/\d{1,2}/g);
  if (!chunks) return [];
  return chunks.map(Number).filter(n => n >= 1 && n <= 49);
}
function validateManualDraw(rawLabel, seven, current) {
  if (!Array.isArray(current) || !current.length) return { error: '本机还没有基准开奖数据，请先一键同步后再补录。' };
  const nums = (Array.isArray(seven) ? seven : []).map(n => (n === '' || n == null ? NaN : Number(n)));
  if (nums.length !== 7) return { error: '需要 7 个号码：前 6 位正码 + 第 7 位特码。' };
  for (let i = 0; i < 7; i++) {
    if (!Number.isInteger(nums[i]) || nums[i] < 1 || nums[i] > 49) {
      return { error: `第 ${i + 1} 位号码无效：${i === 6 ? '特码' : '正' + (i + 1)} 需填 1~49 的整数。` };
    }
  }
  const repeated = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
  if (repeated.length) return { error: '7 个号码须互不重复：' + repeated.map(pad2).join('、') + ' 出现重复。' };
  const labelText = String(rawLabel == null ? '' : rawLabel).trim();
  const p = parseLabel(labelText);
  if (!p) {
    const shaped = /^(\d{4})-(\d{1,3})$/.exec(labelText);
    if (shaped) return { error: `期号 ${labelText} 无效：${shaped[1]} 年最多 ${maxPeriodOfYear(Number(shaped[1]))} 期。` };
    return { error: '期号格式需为「年-三位序号」，例如 2026-325。' };
  }
  const expected = nextLabelOf(current.at(-1).label);
  if (p.label !== expected) return { error: `期号必须紧接最新一期 ${current.at(-1).label}，本期应填 ${expected}。` };
  const numbers = nums.slice(0, 6), special = nums[6];
  if (!validSixNums(numbers)) return { error: '前 6 位正码无效，请重新输入。' };
  return { record: { ...p, date: periodToDate(p.year, p.periodNum), numbers, special, manual: true } };
}
function appendManualDraw(current, record) {
  if (!record || !record.label) throw new Error('缺少可写入的手动记录');
  if (current.some(r => r.label === record.label)) throw new Error('期号 ' + record.label + ' 已存在，未写入');
  if (record.label !== nextLabelOf(current.at(-1).label)) throw new Error('期号不连续，未写入');
  return current.concat([record]);
}
// 只允许撤销最后一条手动记录：若其后已有新期次，撤销会造成期号缺口。
function undoLastManual(current) {
  for (let i = current.length - 1; i >= 0; i--) {
    if (!current[i].manual) continue;
    if (i !== current.length - 1) return { error: `手动记录 ${current[i].label} 之后已有新期次，无法撤销。` };
    return { records: current.slice(0, i), removed: current[i] };
  }
  return { error: '本机没有可撤销的手动补录记录。' };
}
function manualRecords(current) {
  return current.filter(r => r.manual);
}
// 本机存储载荷：与数据源同构，额外带 schema / invalid / manual 标记，便于回填与撤销。
function storagePayload(rows, updatedAt, invalid) {
  return {
    schema: STORAGE_SCHEMA,
    updatedAt: updatedAt || '',
    latestId: rows.length ? rows.at(-1).label : '',
    invalid: Array.isArray(invalid) ? invalid : [],
    draws: rows.map(r => {
      const item = { id: r.label, date: r.date, numbers: r.numbers, special: r.special == null ? null : r.special };
      if (r.manual) item.manual = true;
      return item;
    })
  };
}
if (typeof module !== 'undefined') module.exports = {
  normalizeSource, mergeSource, mergeLocal, buildReplay, summarizeReplay, summarizeSpecial,
  normalizeSpecial, sameSix, parsePastedNumbers, validateManualDraw, appendManualDraw,
  undoLastManual, manualRecords, storagePayload,
  UNIT_STAKE, PAYOUT_MULTIPLIER, GROUPS_PER_PLAN, COST_PER_PERIOD, PRIZE_PER_GROUP,
  SPECIAL_BASELINE_RATE, SPECIAL_RECENT_WINDOW, STORAGE_SCHEMA
};
