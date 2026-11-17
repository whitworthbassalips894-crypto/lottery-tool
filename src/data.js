'use strict';
if (typeof module !== 'undefined') Object.assign(globalThis, require('./engine.js'));
// 仅使用前 6 个平码；特码即使存在也不会进入记录或选号。
const UNIT_STAKE = 2, PAYOUT_MULTIPLIER = 700, GROUPS_PER_PLAN = 35;
const COST_PER_PERIOD = UNIT_STAKE * GROUPS_PER_PLAN;
const PRIZE_PER_GROUP = UNIT_STAKE * PAYOUT_MULTIPLIER;
function normalizeSource(source){
  if (!source || !Array.isArray(source.draws) || !source.draws.length || source.draws.length > 10000) throw new Error('数据源缺少有效开奖记录');
  const map = new Map(), invalid = [];
  for (const item of source.draws) {
    const p = parseLabel(item && item.id);
    if (!p) throw new Error('数据源存在无效期号');
    const numbers = item.numbers;
    if (!validSixNums(numbers)) { invalid.push(p.label); continue; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(item.date || '') ? item.date : periodToDate(p.year, p.periodNum);
    const rec = { ...p, date, numbers: numbers.slice() };
    if (map.has(p.label)) throw new Error('数据源存在重复期号 ' + p.label);
    map.set(p.label, rec);
  }
  const records = [...map.values()].sort((a,b) => a.label.localeCompare(b.label));
  if (!records.length) throw new Error('数据源没有有效的前6码');
  const latest = parseLabel(source.latestId);
  if (latest && invalid.includes(latest.label)) throw new Error('数据源最新一期前6码无效：' + latest.label);
  if (latest && latest.label !== records.at(-1).label) throw new Error('数据源最新期号与记录不一致');
  return { records, invalid, updatedAt: source.updatedAt || '' };
}
function mergeSource(current, source){
  const next = normalizeSource(source);
  if (!current.length) throw new Error('本地没有可核对的基准记录');
  if (next.records.at(-1).label < current.at(-1).label) throw new Error('数据源最新期落后于本地，未写入');
  const old = new Map(current.map(r => [r.label, r]));
  for (const r of next.records) {
    const previous = old.get(r.label);
    if (previous && (previous.numbers.slice().sort((a,b)=>a-b).join(',') !== r.numbers.slice().sort((a,b)=>a-b).join(','))) throw new Error('期号 ' + r.label + ' 与本地记录冲突，未写入；请核对数据源');
  }
  let last = current.at(-1).label;
  const additions = next.records.filter(r => r.label > last);
  for (const r of additions) {
    const expected = nextLabelOf(last);
    if (r.label !== expected) throw new Error('数据源存在缺口：需要 ' + expected + '，未写入');
    last = r.label;
  }
  return { records: current.concat(additions), invalid: next.invalid, added: additions.length, updatedAt: next.updatedAt };
}
function buildReplay(records){
  return records.flatMap((r, i) => {
    const plan = run3in3At(records, i, r.year, r.periodNum, r.date);
    // 数据极少时附件算法可能无法凑满7码，不能将不足7码伪装成复式方案。
    if (plan.opt.length !== 7) return [];
    const actual = new Set(r.numbers), hits = plan.opt.filter(n => actual.has(n));
    const triples = countTriples(hits.length);
    return [{ ...r, recommended: plan.opt, hits, triples, cost: COST_PER_PERIOD, prize: triples * PRIZE_PER_GROUP }];
  });
}
function summarizeReplay(rows){
  const periods = rows.length;
  const winningPeriods = rows.filter(r => r.triples > 0).length;
  const groups = rows.reduce((total, r) => total + r.triples, 0);
  const cost = periods * COST_PER_PERIOD, prize = groups * PRIZE_PER_GROUP;
  return { periods, winningPeriods, groups, cost, prize, net: prize - cost,
    winningRate: periods ? winningPeriods / periods * 100 : 0,
    returnRate: cost ? prize / cost * 100 : 0 };
}
if (typeof module !== 'undefined') module.exports = { normalizeSource, mergeSource, buildReplay, summarizeReplay, UNIT_STAKE, PAYOUT_MULTIPLIER, GROUPS_PER_PLAN, COST_PER_PERIOD, PRIZE_PER_GROUP };
