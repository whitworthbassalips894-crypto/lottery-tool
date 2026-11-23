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

// ---------------------------------------------------------------------------
// 理论期望：固定 7 码与随机 7 码在数学上等价，所以每期的期望只由「开奖口径 + 赔率」决定，
// 与历史、冷热、模型都无关。这些数字是页面「期望」一栏的唯一来源，避免各处硬编码打架。
// ---------------------------------------------------------------------------
const C = (n, k) => { if (k < 0 || k > n) return 0; let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1); return v; };
// 固定 7 码里落在「开奖号」中的个数服从超几何分布；drawn = 参与结算的开奖号个数。
function hypergeomGroups(drawn) {
  let e = 0;
  for (let k = 3; k <= Math.min(drawn, 7); k++) e += C(drawn, k) * C(49 - drawn, 7 - k) / C(49, 7) * C(k, 3);
  return e;
}
// 当前口径：只核对前 6 个平码（drawn = 6）
const EXPECTED_GROUPS_PER_PERIOD = hypergeomGroups(6);       // ≈ 0.037994
const EXPECTED_PRIZE_PER_PERIOD = EXPECTED_GROUPS_PER_PERIOD * PRIZE_PER_GROUP;
const EV_PER_PERIOD = EXPECTED_PRIZE_PER_PERIOD - COST_PER_PERIOD;   // ≈ -16.81 元
const THEORY_RETURN_RATE = EXPECTED_PRIZE_PER_PERIOD / COST_PER_PERIOD * 100;  // ≈ 75.99%
// 对照口径：若销售方把第 7 位特码也算进开奖号（drawn = 7），同一份 700 倍赔率的结论会翻号。
// 页面把两种口径并排给出，让用户对照自己实际下注的规则，而不是只信一个假设。
const ALT_EXPECTED_GROUPS = hypergeomGroups(7);
const ALT_EV_PER_PERIOD = ALT_EXPECTED_GROUPS * PRIZE_PER_GROUP - COST_PER_PERIOD;
const ALT_RETURN_RATE = ALT_EXPECTED_GROUPS * PRIZE_PER_GROUP / COST_PER_PERIOD * 100;
// 打平所需的含本金倍数：低于它就是抽水。
const FAIR_PAYOUT_MULTIPLIER = COST_PER_PERIOD / (EXPECTED_GROUPS_PER_PERIOD * UNIT_STAKE);

// 连错（连续未中）期数的分位数：P(连错 ≥ n) = (1-p)^(n-1)，解出 n = 1 + ln(q)/ln(1-p)。
// 用来把「已经 N 期没中，是不是快出了」按下去——号码固定、开奖独立，随机跟号本来就会有这么长的连错。
// 取最近整数：例如三中三 p=3.095% 时中位 23 期、95 分位 96 期，与逐期模拟一致。
function missRunQuantile(p, q) {
  if (!(p > 0) || !(p < 1) || !(q > 0) || !(q < 1)) return null;
  return Math.max(1, Math.round(1 + Math.log(q) / Math.log(1 - p)));
}
// 命中率与随机基线的差异是否超出抽样噪声：给出 z 值、95% 区间与一句人话结论。
// n 小的时候区间很宽，这一层就是防止把「近 100 期 24%」当成「跑赢随机」。
function significance(wins, periods, baselinePct) {
  const p = baselinePct / 100;
  if (!periods || !(p > 0) || !(p < 1)) return null;
  const se = Math.sqrt(p * (1 - p) / periods);
  const lo = Math.max(0, (p - 1.96 * se) * 100), hi = Math.min(100, (p + 1.96 * se) * 100);
  const rate = wins / periods * 100;
  const z = (wins / periods - p) / se;
  const inside = rate >= lo && rate <= hi;
  return {
    rate, se: se * 100, z, ci95: [lo, hi],
    expected: p * periods,
    verdict: inside ? 'noise' : (rate > hi ? 'above' : 'below'),
    text: inside
      ? `与随机基线无显著差异（z=${z.toFixed(2)}，落在 95% 区间内）`
      : `${rate > hi ? '高于' : '低于'}随机基线，z=${z.toFixed(2)}`
  };
}

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
  if (next.records.at(-1).label < current.at(-1).label) {
    // 用 code 标记这类「不是错误、只是本机更新」的情况，调用方按 code 分流，
    // 不再靠正则匹配中文提示文案（文案一改分流就静默失效）。
    const stale = new Error('来源数据最新期 ' + next.records.at(-1).label + ' 落后于当前记录 ' + current.at(-1).label + '，未写入');
    stale.code = 'STALE_SOURCE';
    throw stale;
  }
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
  // 数据源自己判为无效（例如某期开出重号）的期次不会进入 records，于是在序列里留下空洞。
  // 这不是「来源少了数据」，而是「这一期官方号码本身不可用」——跳过它继续接后面的期次。
  // 否则上游一旦出现一期坏数据，之后每一次同步都会永久卡在「缺口」上（本数据集里的 2022-132 就是这样一期）。
  const declaredInvalid = new Set(next.invalid);
  const skippedInvalid = [];
  for (const r of additions) {
    let expected = nextLabelOf(last);
    for (let guard = 0; expected !== r.label && declaredInvalid.has(expected) && guard < 400; guard++) {
      skippedInvalid.push(expected);
      expected = nextLabelOf(expected);
    }
    if (r.label !== expected) throw new Error('数据源存在缺口：需要 ' + expected + '，未写入');
    last = r.label;
  }
  return { records: base.concat(additions), invalid: next.invalid, added: additions.length, skippedInvalid, specialFilled, confirmed, updatedAt: next.updatedAt };
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
    // 平均每期命中平码数：与随机 7 码的 6×7/49 对照，用来判断回放差异是否只是抽样噪声。
    avgHits: periods ? rows.reduce((total, r) => total + (r.hits ? r.hits.length : 0), 0) / periods : 0,
    baselineAvgHits: RANDOM_AVG_HITS,
    baselineWinningRate: RANDOM_WIN_RATE,
    // 期望口径：固定 7 码与随机 7 码在数学上等价，每期的期望只由「结算口径 + 赔率」决定。
    // 给出期望奖金，才能判断实测盈亏是手气还是抽水——不给的话用户会把噪声当成号码好坏。
    expectedPrize: periods * EXPECTED_PRIZE_PER_PERIOD,
    theoryReturnRate: THEORY_RETURN_RATE,
    evPerPeriod: EV_PER_PERIOD };
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
// 粘贴解析：先剔掉「不是开奖号码」的数字（期号、日期、组数、注数、位序标签），再按 1~2 位切块，
// 只保留 1~49。旧实现直接对整段文本切块，粘贴「第2026327期 2026-11-23 平码 19 04 …」这类
// 官网整行时，期号 2026-327 会被切成 20/26/32/07 顶掉真正的号码——填出来的号码长得完全正常，
// 用户几乎不可能发现。
const PASTE_NOISE = [
  /\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/g,   // 2026-11-23 / 2026年11月23日
  /第?\s*\d{4}\s*[-/]?\s*\d{1,3}\s*期/g,                     // 2026-327期 / 第2026327期
  /(?:正|平|特|第)\s*\d*\s*位?\s*[:：]/g,                    // 正1: / 特码： / 第7位:
  /\d+\s*(?:组|注|倍|元|码|期|年|月|日)/g                     // 35组 / 7码复式 / 2元
];
function stripPasteNoise(text) {
  let out = String(text == null ? '' : text);
  for (const re of PASTE_NOISE) out = out.replace(re, ' ');
  return out;
}
function parsePastedNumbers(text) {
  const chunks = stripPasteNoise(text).match(/\d{1,2}/g);
  if (!chunks) return [];
  return chunks.map(Number).filter(n => n >= 1 && n <= 49);
}
// 从粘贴内容里取出 7 个开奖号，并把「发生了什么」一并返回，绝不让界面静默失败。
// 号码串通常位于整行末尾，因此候选多于 7 个时取最后 7 个。
function pickPastedSeven(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return { error: '还没有粘贴内容。', seven: null };
  const nums = parsePastedNumbers(raw);
  if (!nums.length) return { error: '没有从粘贴内容里认出 1~49 的号码，请直接粘贴 7 个号码，例如「19 04 14 12 21 34 + 43」。', seven: null };
  if (nums.length < 7) {
    const shown = nums.map(pad2).join('、');
    return { error: `只认出 ${nums.length} 个号码（${shown}），还差 ${7 - nums.length} 个。超出 1~49 的数字已被忽略。`, seven: null, found: nums };
  }
  const seven = nums.slice(-7);
  const dup = [...new Set(seven.filter((n, i) => seven.indexOf(n) !== i))];
  return {
    seven,
    dropped: nums.length - 7,
    droppedHead: nums.length > 7 ? nums.slice(0, nums.length - 7).map(pad2).join('、') : '',
    duplicate: dup.length ? dup.map(pad2).join('、') : ''
  };
}
function validateManualDraw(rawLabel, seven, current, opts) {
  const mode = (opts && opts.mode) || 'append';
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
    if (shaped) {
      const year = Number(shaped[1]), num = Number(shaped[2]), max = maxPeriodOfYear(year);
      // 分清两种情况：真的超出该年期数，还是只是序号没写满三位。
      // 旧实现对 2026-31 回「2026 年最多 365 期」，而 31 < 365，这句话解释不通。
      if (num > max) return { error: `期号 ${labelText} 无效：${year} 年最多 ${max} 期。` };
      return { error: `期号 ${labelText} 无效：序号需三位，应写 ${year}-${String(num).padStart(3, '0')}。` };
    }
    return { error: '期号格式需为「年-三位序号」，例如 2026-325。' };
  }
  const expected = nextLabelOf(current.at(-1).label);
  if (mode === 'replace') {
    // 修改模式：期号必须就是当前最新一期，而且那一条得是手动补录，否则无从改起。
    const lastRec = current.at(-1);
    if (p.label !== lastRec.label) return { error: `只能修改最新一期 ${lastRec.label} 的号码，不能改期号。` };
    if (!lastRec.manual) return { error: `最新一期 ${lastRec.label} 来自数据源，不是手动补录，不能在这里修改。` };
  } else if (p.label !== expected) {
    return { error: `期号必须紧接最新一期 ${current.at(-1).label}，本期应填 ${expected}。` };
  }
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
// 改掉最后一条手动记录的号码：录错一个号时不必「全部撤销再重录」。
// 只允许改最后一条，且不能改成已存在的期号——中间的手动记录一旦改动会造成对不上账。
function replaceLastManual(current, record) {
  if (!record || !record.label) throw new Error('缺少可写入的手动记录');
  let idx = -1;
  for (let i = current.length - 1; i >= 0; i--) { if (current[i].manual) { idx = i; break; } }
  if (idx < 0) throw new Error('本机没有可修改的手动补录记录');
  if (idx !== current.length - 1) throw new Error('手动记录 ' + current[idx].label + ' 之后已有新期次，无法修改。');
  if (record.label !== current[idx].label) throw new Error('只能修改期号 ' + current[idx].label + ' 的号码，不能改成其他期号。');
  const next = current.slice();
  next[idx] = { ...record, manual: true };
  return { records: next, replaced: current[idx], record: next[idx] };
}
function manualRecords(current) {
  return current.filter(r => r.manual);
}
// 跟号账本：从 followSince 那天（含）起算，累计投入／返奖／盈亏，以及距回本还差几组。
// 号码固定就意味着「长期押同一注」，用户真正想知道的是自己从哪天开始跟、跟到现在是赚是亏，
// 而不是一个滚动的「近 100 期」窗口。
function followLedger(rows, followSince) {
  if (!followSince) return null;
  const from = rows.filter(r => r.date >= followSince);
  if (!from.length) return { active: false, periods: 0 };
  const periods = from.length;
  const groups = from.reduce((total, r) => total + r.triples, 0);
  const cost = periods * COST_PER_PERIOD, prize = groups * PRIZE_PER_GROUP;
  const net = prize - cost;
  // 还差多少组中奖才能把累计投入赚回来（已回本则为 0）
  const groupsToBreakEven = net >= 0 ? 0 : Math.ceil(-net / PRIZE_PER_GROUP);
  return {
    active: true, since: followSince, periods, groups, cost, prize, net,
    groupsToBreakEven,
    firstLabel: from[0].label, lastLabel: from.at(-1).label,
    winningPeriods: from.filter(r => r.triples > 0).length,
    specialWins: from.filter(r => r.specialHit === true).length,
    specialPeriods: from.filter(r => r.special != null).length,
    // 同样给出这段区间的期望，好判断实际盈亏是手气还是抽水
    expectedPrize: periods * EXPECTED_PRIZE_PER_PERIOD
  };
}
// 本机存储载荷：与数据源同构，额外带 schema / invalid / manual 标记，便于回填与撤销。
function storagePayload(rows, updatedAt, invalid, extra) {
  const e = extra || {};
  return {
    schema: STORAGE_SCHEMA,
    updatedAt: updatedAt || '',
    latestId: rows.length ? rows.at(-1).label : '',
    invalid: Array.isArray(invalid) ? invalid : [],
    // 跟号账本起点：纯附加信息，normalizeSource 会忽略，旧版本读到也不受影响。
    ...(e.followSince ? { followSince: e.followSince } : {}),
    draws: rows.map(r => {
      const item = { id: r.label, date: r.date, numbers: r.numbers, special: r.special == null ? null : r.special };
      if (r.manual) item.manual = true;
      return item;
    })
  };
}
if (typeof module !== 'undefined') module.exports = {
  normalizeSource, mergeSource, mergeLocal, buildReplay, summarizeReplay, summarizeSpecial,
  normalizeSpecial, sameSix, parsePastedNumbers, pickPastedSeven, stripPasteNoise, validateManualDraw,
  appendManualDraw, replaceLastManual, followLedger, significance,
  undoLastManual, manualRecords, storagePayload, missRunQuantile,
  UNIT_STAKE, PAYOUT_MULTIPLIER, GROUPS_PER_PLAN, COST_PER_PERIOD, PRIZE_PER_GROUP,
  SPECIAL_BASELINE_RATE, SPECIAL_RECENT_WINDOW, STORAGE_SCHEMA,
  EXPECTED_GROUPS_PER_PERIOD, EXPECTED_PRIZE_PER_PERIOD, EV_PER_PERIOD, THEORY_RETURN_RATE,
  ALT_EXPECTED_GROUPS, ALT_EV_PER_PERIOD, ALT_RETURN_RATE, FAIR_PAYOUT_MULTIPLIER, hypergeomGroups
};
