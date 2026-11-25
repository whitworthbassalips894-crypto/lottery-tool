'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine.js');
const {
  normalizeSource, mergeSource, mergeLocal, buildReplay, summarizeReplay, summarizeSpecial,
  normalizeSpecial, parsePastedNumbers, pickPastedSeven, validateManualDraw, appendManualDraw,
  replaceLastManual, followLedger, significance, missRunQuantile,
  undoLastManual, manualRecords, storagePayload,
  COST_PER_PERIOD, PRIZE_PER_GROUP, SPECIAL_BASELINE_RATE,
  EXPECTED_GROUPS_PER_PERIOD, EXPECTED_PRIZE_PER_PERIOD, EV_PER_PERIOD, THEORY_RETURN_RATE,
  ALT_RETURN_RATE, FAIR_PAYOUT_MULTIPLIER
} = require('../src/data.js');
const snapshot = require('../data/draws.json');

const source = (draws, latestId, updatedAt = '2026-11-21') => ({ updatedAt, latestId, draws });
// 上游格式：numbers 是前 6 位平码，special 是第 7 位特码
const sample = (id, numbers = [1, 2, 3, 4, 5, 6], special = 49, extra = {}) => ({ id, date: '2026-11-23', numbers, special, ...extra });

const base = normalizeSource(snapshot);
const records = base.records;
const replay = buildReplay(records);
const replayByLabel = new Map(replay.map(r => [r.label, r]));

test('内置快照：前6平码保持不变，并补齐每期第7位特码', () => {
  assert.equal(snapshot.draws.length, 1787);
  assert.equal(snapshot.latestId, '2026-326');
  assert.equal(records.length, 1786);
  assert.deepEqual(base.invalid, ['2022-132']);
  const last = records.at(-1);
  assert.equal(last.label, '2026-326');
  assert.deepEqual(last.numbers, [9, 16, 22, 36, 5, 47]);
  assert.equal(last.special, 23);
  assert.equal(last.date, '2026-11-22');
  // 历史数据的平码必须与原快照逐期一致（金样抽查：取自改版前的 data/draws.json）
  const golden = {
    '2022-001': { numbers: [49, 26, 5, 28, 7, 2], date: '2022-01-01', special: 22 },
    '2022-132': { numbers: [15, 44, 27, 33, 33, 18], date: '2022-05-12' }, // 平码重复，仍按旧口径整期排除
    '2024-060': { numbers: [43, 45, 31, 16, 27, 38], date: '2024-02-29' }, // 闰年第 60 期
    '2025-001': { numbers: [25, 18, 6, 14, 29, 39], date: '2025-01-01' },
    '2026-001': { numbers: [27, 8, 43, 33, 42, 11], date: '2026-01-01' },
    '2026-320': { numbers: [14, 17, 32, 34, 24, 46], date: '2026-11-16' },
    '2026-324': { numbers: [19, 4, 14, 12, 21, 34], date: '2026-11-20', special: 43 },
    '2026-325': { numbers: [41, 37, 10, 1, 27, 17], date: '2026-11-21', special: 3 },
    '2026-326': { numbers: [9, 16, 22, 36, 5, 47], date: '2026-11-22', special: 23 }
  };
  const rawById = new Map(snapshot.draws.map(d => [d.id, d]));
  for (const [label, g] of Object.entries(golden)) {
    const raw = rawById.get(label);
    assert.ok(raw, '快照缺少期号 ' + label);
    assert.deepEqual(raw.numbers, g.numbers, label + ' 平码被改动');
    assert.equal(raw.date, g.date, label + ' 日期被改动');
    if (g.special != null) assert.equal(raw.special, g.special, label + ' 特码不符');
    else assert.ok(Number.isInteger(raw.special) && raw.special >= 1 && raw.special <= 49, label + ' 特码缺失');
  }
  assert.equal(records[0].label, '2022-001');
  assert.ok(rawById.has('2022-132'), '原始快照应保留重复号码期，由统计口径排除');
  assert.equal(records.some(r => r.label === '2022-132'), false);
  // 特码：每期都有、范围合法、且不与平码重复
  assert.ok(records.every(r => Number.isInteger(r.special) && r.special >= 1 && r.special <= 49));
  assert.ok(records.every(r => !r.numbers.includes(r.special)));
  assert.ok(records.every(r => r.numbers.length === 6));
  assert.ok(records.every(r => !('manual' in r)));
});

test('特码记录归一化：无效特码归为未记录；热冷随机v1只用平码历史，特码不影响推荐', () => {
  assert.equal(normalizeSpecial(43), 43);
  assert.equal(normalizeSpecial(0), null);
  assert.equal(normalizeSpecial(50), null);
  assert.equal(normalizeSpecial('43'), null);
  assert.equal(normalizeSpecial(undefined), null);
  const loose = normalizeSource(source([
    sample('2026-321', [1, 2, 3, 4, 5, 6], 50),
    sample('2026-322', [7, 8, 9, 10, 11, 12], null),
    sample('2026-323', [13, 14, 15, 16, 17, 18], 49)
  ], '2026-323'));
  assert.deepEqual(loose.records.map(r => r.special), [null, null, 49]);
  assert.deepEqual(loose.invalid, []);
  // 平码无效仍然整期排除，特码不救回该期
  assert.throws(() => normalizeSource(source([sample('2026-324', [1, 1, 2, 3, 4, 5], 9)], '2026-324')), /没有有效|无效/);
  // 热冷随机v1只基于平码频次/遗漏选码：改动特码不应影响推荐
  const mutated = records.map(r => ({ ...r, special: ((r.special || 1) % 49) + 1 }));
  const mutatedReplay = buildReplay(mutated.slice(0, 400));
  const originalReplay = buildReplay(records.slice(0, 400));
  assert.equal(mutatedReplay.length, originalReplay.length);
  assert.deepEqual(mutatedReplay.map(r => r.recommended), originalReplay.map(r => r.recommended), '热冷随机v1不应受特码历史影响');
});

test('热冷随机 v1 内核：3热2冷2随机、确定性可追踪、walk-forward', () => {
  const next = engine.nextLabelOf(records.at(-1).label);
  const p = engine.parseLabel(next);
  const rec = engine.run3in3At(records, records.length, p.year, p.periodNum, engine.periodToDate(p.year, p.periodNum));
  assert.equal(rec.method, 'hcr-v1');
  assert.equal(rec.label, next);
  assert.equal(rec.opt.length, 7);
  assert.equal(new Set(rec.opt).size, 7);
  assert.ok(rec.opt.every(n => Number.isInteger(n) && n >= 1 && n <= 49));
  assert.deepEqual(rec.opt, rec.opt.slice().sort((a, b) => a - b), '推荐号码应按升序展示');
  // 确定性：同样输入得到同样输出
  const again = engine.run3in3At(records, records.length, p.year, p.periodNum, engine.periodToDate(p.year, p.periodNum));
  assert.deepEqual(again.opt, rec.opt);
  assert.deepEqual(again.trace, rec.trace);
  // 可追踪：trace 包含规则、种子、热冷池与选中结果
  assert.equal(rec.trace.ruleVersion, 'hcr-v1');
  assert.equal(rec.trace.hotWindow, 60);
  assert.equal(rec.trace.pickedHot.length, 3);
  assert.equal(rec.trace.pickedCold.length, 2);
  assert.equal(rec.trace.pickedRandom.length, 2);
  assert.deepEqual([...rec.trace.pickedHot, ...rec.trace.pickedCold, ...rec.trace.pickedRandom].sort((a,b)=>a-b), rec.opt);
  // 动态：历史变化时结果可以变化
  const alt = engine.run3in3At(records.slice(0, 200), 200, p.year, p.periodNum, engine.periodToDate(p.year, p.periodNum));
  assert.equal(alt.opt.length, 7);
  // 历史不足时返回空推荐，不伪造 7 码
  const short = engine.run3in3At(records.slice(0, 30), 30, p.year, p.periodNum, engine.periodToDate(p.year, p.periodNum));
  assert.deepEqual(short.opt, []);
  assert.equal(short.method, 'hcr-v1');
  // 随机基线常量与理论值一致（仅用于指标卡对照）
  assert.ok(Math.abs(engine.RANDOM_WIN_RATE - 3.095178) < 1e-5);
  assert.ok(Math.abs(engine.RANDOM_AVG_INTERVAL - 32.3083) < 1e-3);
  assert.ok(Math.abs(engine.RANDOM_AVG_HITS - 0.857143) < 1e-5);
  assert.equal(engine.buildAll35Triples(rec.opt).length, 35);
  assert.equal(engine.zodiacOfNumber(43, '2026-11-20'), '鼠');
  assert.equal(engine.WAVE_MAP[43], 'green');
});

test('回放逐期只使用同期之前的记录，并同时给出三中三与特码命中', () => {
  // 热冷随机v1需要足够历史（>=60期）；历史不足的早期期次会跳过
  assert.ok(replay.length > 1700 && replay.length <= records.length);
  assert.ok(replay.length < records.length, '早期历史不足时应跳过，而不是伪造推荐');
  assert.ok(replay.every(r => r.recommended.length === 7));
  assert.ok(replay.every(r => r.specialHit === r.recommended.includes(r.special)));
  assert.ok(replay.every(r => r.specialHit === true || r.specialHit === false));
  for (const label of [replay[0].label, replay[100].label, replay.at(-1).label]) {
    const r = replayByLabel.get(label);
    const i = records.findIndex(x => x.label === label);
    const before = records.slice(0, i);
    const expected = engine.run3in3At(before, before.length, r.year, r.periodNum, r.date).opt;
    assert.deepEqual(r.recommended, expected);
    assert.equal(r.triples, engine.countTriples(expected.filter(n => r.numbers.includes(n)).length));
    assert.equal(r.cost, COST_PER_PERIOD);
    assert.equal(r.prize, r.triples * PRIZE_PER_GROUP);
  }
  // 改动之后的期次不能影响之前任何一期的方案
  const altered = records.slice(); altered[100] = { ...altered[100], numbers: [1, 2, 3, 4, 5, 6], special: 49 };
  const original = buildReplay(records.slice(0, 150)).find(r => r.label === records[100].label);
  const changed = buildReplay(altered.slice(0, 150)).find(r => r.label === records[100].label);
  assert.deepEqual(changed.recommended, original.recommended);
  // 特码缺失的期次：三中三照常统计，特码命中记为 null（不计入特码样本）
  const noSpecial = records.slice(0, 120).map((r, i) => (i === 119 ? { ...r, special: null } : r));
  const rows = buildReplay(noSpecial);
  const lastRow = rows.at(-1);
  assert.equal(lastRow.specialHit, null);
  assert.equal(lastRow.special, null);
  assert.equal(lastRow.recommended.length, 7);
});

test('热冷随机v1回放口径：动态推荐、walk-forward、统计口径正确', () => {
  const stats = summarizeReplay(replay);
  assert.equal(stats.periods, replay.length);
  assert.ok(stats.periods > 1700);
  // 动态推荐：不应所有期都同一组号码
  const uniq = new Set(replay.map(r => r.recommended.join(',')));
  assert.ok(uniq.size > 100, `推荐应随历史变化，实际只有 ${uniq.size} 种`);
  // 统计量应在合理范围内（模型不保证跑赢随机）
  assert.ok(stats.avgHits > 0.7 && stats.avgHits < 1.1, `平均命中 ${stats.avgHits} 异常`);
  assert.ok(stats.winningRate > 1 && stats.winningRate < 6, `有奖率 ${stats.winningRate} 异常`);
  const sp = summarizeSpecial(replay);
  assert.ok(sp.rate > 8 && sp.rate < 22, `特码命中率 ${sp.rate} 异常`);
  // 金额口径仍按 35 组 × 2 元，中奖组 1,400 元
  const groups = replay.reduce((sum, r) => sum + r.triples, 0);
  assert.equal(stats.cost, stats.periods * 70);
  assert.equal(stats.prize, groups * 1400);
});

test('三中三金额口径不变：每注2元、中奖总返奖700倍', () => {
  const rows = [0, 1, 4, 10, 20].map(triples => ({ triples }));
  const stats = summarizeReplay(rows);
  // 期望值一栏只由赔率口径决定，与这份 rows 无关，单独断言，不混进金额口径的比较里
  const theory = {
    expectedPrize: stats.expectedPrize, theoryReturnRate: stats.theoryReturnRate, evPerPeriod: stats.evPerPeriod
  };
  assert.equal(Math.round(theory.theoryReturnRate * 100) / 100, 75.99);
  assert.equal(Math.round(theory.evPerPeriod * 100) / 100, -16.81);
  assert.equal(Math.round(stats.expectedPrize * 100) / 100, Math.round(stats.periods * EXPECTED_PRIZE_PER_PERIOD * 100) / 100);
  const rest = { ...stats, avgHits: undefined, baselineAvgHits: undefined, baselineWinningRate: undefined, ...theory };
  assert.deepEqual(
    { ...rest, expectedPrize: undefined, theoryReturnRate: undefined, evPerPeriod: undefined },
    {
      periods: 5, winningPeriods: 4, groups: 35, cost: 350, prize: 49000, net: 48650,
      winningRate: 80, returnRate: 14000, avgHits: undefined, baselineAvgHits: undefined, baselineWinningRate: undefined,
      expectedPrize: undefined, theoryReturnRate: undefined, evPerPeriod: undefined
    });
  assert.equal(summarizeReplay([]).periods, 0);
  assert.equal(summarizeReplay([]).avgHits, 0);
  assert.equal(summarizeReplay([]).net, 0);
  for (const row of replay.slice(0, 80)) {
    assert.equal(row.cost, 70);
    assert.equal(row.prize, row.triples * 1400);
  }
});

test('特码命中统计：命中率、连错、间隔与随机基线，特码缺失不计入样本', () => {
  const mk = (hit, special = 43) => ({ special, specialHit: hit, triples: 0 });
  const stats = summarizeSpecial([mk(false), mk(false), mk(true), mk(false), mk(false), mk(false), mk(true), mk(false)]);
  assert.equal(stats.periods, 8);
  assert.equal(stats.unknown, 0);
  assert.equal(stats.wins, 2);
  assert.equal(stats.misses, 6);
  assert.equal(stats.rate, 25);
  assert.equal(stats.interval, 4);
  assert.equal(stats.currentMiss, 1);
  assert.equal(stats.maxMiss, 3);
  assert.equal(stats.recentPeriods, 8);
  assert.equal(stats.recentWins, 2);
  assert.equal(Math.round(stats.baseline * 100) / 100, 14.29);
  assert.equal(SPECIAL_BASELINE_RATE, 7 / 49 * 100);
  // 特码未记录的期次不计入分母，也不打断连错计数
  const partial = summarizeSpecial([mk(false), { special: null, specialHit: null }, mk(true), { special: null, specialHit: null }, mk(false)]);
  assert.equal(partial.periods, 3);
  assert.equal(partial.unknown, 2);
  assert.equal(partial.wins, 1);
  assert.equal(partial.currentMiss, 1);
  assert.equal(partial.maxMiss, 1);
  assert.deepEqual(summarizeSpecial([]), {
    periods: 0, unknown: 0, wins: 0, misses: 0, rate: 0, baseline: SPECIAL_BASELINE_RATE,
    interval: null, currentMiss: 0, maxMiss: 0, recentPeriods: 0, recentWins: 0
  });
  // 全量近100期：命中数必须与逐期判定一致
  const recent = replay.slice(-100);
  const real = summarizeSpecial(recent);
  assert.equal(real.wins, recent.filter(r => r.specialHit).length);
  assert.equal(real.periods, 100);
});

test('同步只追加连续有效数据；平码或特码冲突、缺口、落后源都不写入', () => {
  const extra = sample('2026-327', [3, 11, 22, 35, 41, 48], 7);
  const res = mergeSource(records, source([...snapshot.draws, extra], '2026-327'));
  assert.equal(res.added, 1);
  assert.equal(res.records.at(-1).label, '2026-327');
  assert.equal(res.records.at(-1).special, 7);
  assert.equal(records.at(-1).label, '2026-326');
  assert.throws(() => mergeSource(records, source([...snapshot.draws, sample('2026-328')], '2026-328')), /缺口/);
  const conflict = snapshot.draws.map(d => (d.id === '2026-326' ? { ...d, numbers: [1, 2, 3, 4, 5, 6] } : d));
  assert.throws(() => mergeSource(records, source(conflict, '2026-326')), /冲突/);
  const specialConflict = snapshot.draws.map(d => (d.id === '2026-326' ? { ...d, special: 1 } : d));
  assert.throws(() => mergeSource(records, source(specialConflict, '2026-326')), /特码冲突/);
  assert.throws(() => mergeSource(res.records, snapshot), /落后/);
  assert.throws(() => mergeSource([], source([extra], '2026-327')), /基准记录/);
});

test('同步会回填旧数据缺失的特码，并确认已被数据源收录的手动记录', () => {
  // 旧版本机数据：没有特码字段（起点在无效期 2022-132 之后，避免历史缺口干扰追加校验）
  const legacy = records.slice(0, 200).map(r => ({ id: r.label, date: r.date, numbers: r.numbers }));
  const legacyCurrent = normalizeSource(source(legacy, legacy.at(-1).id)).records;
  assert.ok(legacyCurrent.every(r => r.special === null));
  const filled = mergeSource(legacyCurrent, snapshot);
  assert.equal(filled.specialFilled, 200);
  assert.ok(filled.records.every(r => Number.isInteger(r.special)));
  // 回填只补特码，200 期既有平码一字未改
  assert.deepEqual(filled.records.slice(0, 200).map(r => r.label + ':' + r.numbers.join(',')),
    legacyCurrent.map(r => r.label + ':' + r.numbers.join(',')));
  assert.equal(filled.records.length, records.length);
  // 手动记录被上游收录（号码一致）后不再算手动，撤销不会误删官方数据
  const manual = { ...records.at(-1), manual: true };
  const withManual = records.slice(0, -1).concat([manual]);
  const confirmed = mergeSource(withManual, snapshot);
  assert.equal(confirmed.confirmed, 1);
  assert.deepEqual(manualRecords(confirmed.records), []);
  // 本机备份里的手动标记要保留
  const saved = mergeSource(records.slice(0, -1), source(storagePayload(withManual, '2026-11-20', []).draws, manual.label));
  assert.equal(manualRecords(saved.records).length, 1);
});

test('打开页面合并本机备份：内置更新/本机更新两个方向都合得上，冲突以官方为准并留说明', () => {
  // 本机备份落后（站点发布过新内置快照）：合并成功，不能整份作废
  const older = storagePayload(records.filter(r => r.label <= '2026-323'), '2026-11-19', []);
  const merged = mergeLocal(records, older);
  assert.equal(merged.records.length, records.length);
  assert.equal(merged.records.at(-1).label, '2026-326');
  assert.equal(merged.added, 0);
  assert.deepEqual(merged.conflicts, []);
  // 本机备份领先（同步过更新的数据 + 手动补录）：多出的期次按期号连续追加并保留手动标记
  const aheadDraws = [
    { id: '2026-327', date: '2026-11-23', numbers: [3, 11, 22, 35, 41, 48], special: 7, manual: true },
    { id: '2026-328', date: '2026-11-24', numbers: [5, 9, 14, 27, 33, 44], special: 19, manual: true },
    ...records.map(r => ({ id: r.label, date: r.date, numbers: r.numbers, special: r.special }))
  ];
  const ahead = mergeLocal(records, source(aheadDraws, '2026-328'));
  assert.equal(ahead.records.at(-1).label, '2026-328');
  assert.equal(ahead.added, 2);
  assert.equal(ahead.manualKept, 2);
  assert.deepEqual(ahead.records.slice(-2).map(r => r.manual), [true, true]);
  // 备份里的手动记录已被官方收录（号码一致）→ 记确认，不再保留 manual
  const confirmedSource = records.map(r => (r.label === '2026-326' ? { id: r.label, date: r.date, numbers: r.numbers, special: r.special, manual: true } : { id: r.label, date: r.date, numbers: r.numbers, special: r.special }));
  const confirmed = mergeLocal(records, source(confirmedSource, '2026-326'));
  assert.equal(confirmed.manualConfirmed, 1);
  assert.equal(confirmed.records.some(r => r.manual), false);
  // 手动记录与官方不符 → 以官方为准，并给出可读说明（不静默覆盖）
  const wrongSix = records.map(r => (r.label === '2026-326' ? { id: r.label, date: r.date, numbers: [1, 2, 3, 4, 5, 6], special: r.special, manual: true } : { id: r.label, date: r.date, numbers: r.numbers, special: r.special }));
  const fixed = mergeLocal(records, source(wrongSix, '2026-326'));
  assert.deepEqual(fixed.records.at(-1).numbers, records.at(-1).numbers);
  assert.equal(fixed.records.some(r => r.manual), false);
  assert.equal(fixed.manualDropped, 1);
  assert.match(fixed.conflicts.join('；'), /2026-326 的手动补录与官方开奖号码不一致/);
  const wrongSpecial = records.map(r => (r.label === '2026-326' ? { id: r.label, date: r.date, numbers: r.numbers, special: 1 } : { id: r.label, date: r.date, numbers: r.numbers, special: r.special }));
  assert.match(mergeLocal(records, source(wrongSpecial, '2026-326')).conflicts.join('；'), /特码不一致（本机 01 \/ 官方 23）/);
  // 内置快照缺特码时由本机备份补全（反向回填）
  const builtinNoSpecial = records.map(r => (r.label > '2026-319' ? { ...r, special: null } : r));
  const filled = mergeLocal(builtinNoSpecial, source(records.map(r => ({ id: r.label, date: r.date, numbers: r.numbers, special: r.special })), '2026-326'));
  assert.equal(filled.specialFilled, 7);
  assert.ok(filled.records.slice(-7).every(r => r.special != null));
  // 备份有缺口时拒绝采用，避免出现断档
  const gap = source([{ id: '2026-328', date: '2026-11-24', numbers: [1, 2, 3, 4, 5, 6], special: 7 }, ...records.map(r => ({ id: r.label, date: r.date, numbers: r.numbers, special: r.special }))], '2026-328');
  assert.throws(() => mergeLocal(records, gap), /缺口/);
});

test('手动补录校验：7 个号码互不重复、期号必须紧接最新一期', () => {
  const seven = [3, 11, 22, 35, 41, 48, 7];
  const ok = validateManualDraw('2026-327', seven, records);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.record, {
    year: 2026, periodNum: 327, label: '2026-327', date: '2026-11-23',
    numbers: [3, 11, 22, 35, 41, 48], special: 7, manual: true
  });
  assert.match(validateManualDraw('2026-327', seven.slice(0, 6), records).error, /需要 7 个号码/);
  assert.match(validateManualDraw('2026-327', [3, 11, 22, 35, 41, 48, 50], records).error, /第 7 位号码无效/);
  assert.match(validateManualDraw('2026-327', [0, 11, 22, 35, 41, 48, 7], records).error, /第 1 位号码无效/);
  assert.match(validateManualDraw('2026-327', [3, 3, 22, 35, 41, 48, 7], records).error, /互不重复/);
  assert.match(validateManualDraw('2026-327', [3, 11, 22, 35, 41, 48, 48], records).error, /互不重复/);
  assert.match(validateManualDraw('325', seven, records).error, /期号格式/);
  assert.match(validateManualDraw('2026-999', seven, records).error, /最多 365 期/);
  assert.match(validateManualDraw('2026-329', seven, records).error, /必须紧接最新一期 2026-326/);
  assert.match(validateManualDraw('2026-327', seven, []).error, /基准开奖数据/);
  // 字符串数字（输入框取值）也可接受
  assert.equal(validateManualDraw('2026-327', ['3', '11', '22', '35', '41', '48', '7'], records).record.special, 7);
  assert.equal(validateManualDraw('2026-327', ['03', '11', '22', '35', '41', '48', '07'], records).record.numbers[0], 3);
});

test('手动记录写入、撤销与本机载荷', () => {
  const { record } = validateManualDraw('2026-327', [3, 11, 22, 35, 41, 48, 7], records);
  assert.equal(record.label, '2026-327');
  const next = appendManualDraw(records, record);
  assert.equal(next.length, records.length + 1);
  assert.equal(next.at(-1).label, '2026-327');
  assert.deepEqual(manualRecords(next).map(r => r.label), ['2026-327']);
  assert.throws(() => appendManualDraw(next, record), /已存在/);
  assert.throws(() => appendManualDraw(records, { ...record, label: '2026-328', periodNum: 328 }), /不连续/);
  // 撤销最后一条手动记录
  const undone = undoLastManual(next);
  assert.equal(undone.error, undefined);
  assert.equal(undone.removed.label, '2026-327');
  assert.deepEqual(undone.records.map(r => r.label), records.map(r => r.label));
  assert.match(undoLastManual(records).error, /没有可撤销/);
  // 手动记录之后又同步进新期次时不允许撤销（会造成期号缺口）
  const withNewer = next.concat([{
    year: 2026, periodNum: 328, label: '2026-328', date: '2026-11-24',
    numbers: [1, 2, 3, 4, 5, 6], special: 9
  }]);
  assert.match(undoLastManual(withNewer).error, /之后已有新期次/);
  // 本机载荷：带 schema、特码、无效期与手动标记，且能被 normalizeSource 读回
  const payload = storagePayload(next, '2026-11-23', base.invalid);
  assert.equal(payload.schema, 2);
  assert.equal(payload.latestId, '2026-327');
  assert.deepEqual(payload.invalid, ['2022-132']);
  assert.equal(payload.draws.at(-1).special, 7);
  assert.equal(payload.draws.at(-1).manual, true);
  assert.equal(payload.draws.at(-2).manual, undefined);
  assert.equal(payload.draws.at(-1).numbers.length, 6);
  const reread = normalizeSource(payload);
  assert.equal(reread.records.at(-1).label, '2026-327');
  assert.equal(reread.records.at(-1).special, 7);
  assert.equal(reread.records.at(-1).manual, true);
  assert.deepEqual(reread.invalid, []);
});

test('粘贴解析口径与参考工具一致：按 1~2 位切块并只保留 1~49', () => {
  assert.deepEqual(parsePastedNumbers('19 04 14 12 21 34 + 43'), [19, 4, 14, 12, 21, 34, 43]);
  assert.deepEqual(parsePastedNumbers('19,4,14,12,21,34,43'), [19, 4, 14, 12, 21, 34, 43]);
  assert.deepEqual(parsePastedNumbers('19、04、14、12、21、34、43'), [19, 4, 14, 12, 21, 34, 43]);
  assert.deepEqual(parsePastedNumbers('19041412213443'), [19, 4, 14, 12, 21, 34, 43]);
  assert.deepEqual(parsePastedNumbers('50 60 70'), []);
  assert.deepEqual(parsePastedNumbers(''), []);
  assert.deepEqual(parsePastedNumbers(null), []);
  assert.equal(parsePastedNumbers('1 2 3').length, 3);
});

test('粘贴解析：官网整行、工具自己的复制文案、位序标签都能取对号码，取不够时明确报错', () => {
  // 旧实现对整段文本按 1~2 位硬切，期号 2026-327 会被切成 20/26/32/07 顶掉真正的号码，
  // 填出来的号码看着完全正常——这是最容易把错号存进去的路径。
  const cases = [
    ['三中三 2026-327期 · 7码复式（35组）：01、06、16、34、39、43、46', [1, 6, 16, 34, 39, 43, 46]],
    ['第2026327期 开奖日期 2026-11-23 平码 19 04 14 12 21 34 特码 43', [19, 4, 14, 12, 21, 34, 43]],
    ['2026-327  2026年11月23日  开奖号码：19,04,14,12,21,34 + 43', [19, 4, 14, 12, 21, 34, 43]],
    ['正1:19 正2:04 正3:14 正4:12 正5:21 正6:34 特:43', [19, 4, 14, 12, 21, 34, 43]],
    ['19 04 14 12 21 34 + 43', [19, 4, 14, 12, 21, 34, 43]],
    ['19041412213443', [19, 4, 14, 12, 21, 34, 43]]
  ];
  for (const [text, want] of cases) {
    const res = pickPastedSeven(text);
    assert.equal(res.error, undefined, `不该报错：${text}`);
    assert.deepEqual(res.seven, want, `取错号码：${text}`);
    assert.equal(res.duplicate, '');
  }
  // 丢弃了非开奖数字时要说清楚丢了什么，不能悄悄改数据
  const noisy = pickPastedSeven('备注 2026 号码 01 06 16 34 39 43 46');
  assert.deepEqual(noisy.seven, [1, 6, 16, 34, 39, 43, 46]);
  assert.equal(noisy.dropped, 2);
  assert.equal(noisy.droppedHead, '20、26');
  // 号码不够 7 个：必须报错，绝不静默不动（旧实现直接 return，用户以为输入框坏了）
  const short = pickPastedSeven('19 04 14 12 21 34 60');
  assert.match(short.error, /只认出 6 个号码/);
  assert.deepEqual(short.found, [19, 4, 14, 12, 21, 34]);
  assert.match(pickPastedSeven('50 60 70').error, /没有从粘贴内容里认出/);
  assert.match(pickPastedSeven('').error, /还没有粘贴内容/);
  // 重复号码要提前指出，不等保存时才拦
  assert.equal(pickPastedSeven('19 04 19 12 21 34 43').duplicate, '19');
});

test('显著性与连错分位：把「近100期看着更高」还原成抽样噪声', () => {
  // 近 100 期特码 24/100：绝对值高于基线，但 n 太小时区间很宽，必须原样告诉用户
  const small = significance(24, 100, SPECIAL_BASELINE_RATE);
  assert.equal(Math.round(small.ci95[0] * 10) / 10, 7.4);
  assert.equal(Math.round(small.ci95[1] * 10) / 10, 21.1);
  assert.ok(Math.abs(small.z - 2.78) < 0.01);
  // 全样本 251/1786：落在区间内，结论就是「与随机无显著差异」
  const full = significance(251, 1786, SPECIAL_BASELINE_RATE);
  assert.equal(full.verdict, 'noise');
  assert.match(full.text, /无显著差异/);
  assert.equal(significance(0, 0, SPECIAL_BASELINE_RATE), null);
  // 连错分位：P(连错 ≥ n) = (1-p)^(n-1)
  assert.equal(missRunQuantile(7 / 49, 0.5), 5);
  assert.ok(missRunQuantile(0.030951780258, 0.5) === 23);
  assert.ok(missRunQuantile(0.030951780258, 0.05) > 90);
  assert.equal(missRunQuantile(0, 0.5), null);
});

test('理论期望：只算前6平码时每期必亏，若特码也算开奖号则结论翻号', () => {
  assert.equal(Math.round(EXPECTED_GROUPS_PER_PERIOD * 1e6) / 1e6, 0.037994);
  assert.equal(Math.round(THEORY_RETURN_RATE * 100) / 100, 75.99);
  assert.equal(Math.round(EV_PER_PERIOD * 100) / 100, -16.81);
  // 同一份 700 倍赔率，只因「特码算不算开奖号」，期望就从 -16.81 翻成 +23.09
  assert.ok(ALT_RETURN_RATE > 130 && ALT_RETURN_RATE < 134);
  // 打平需要约 921 倍（含本金），700 倍本身就是抽水
  assert.ok(FAIR_PAYOUT_MULTIPLIER > 900 && FAIR_PAYOUT_MULTIPLIER < 940);
});

test('上游一期坏号码不再永久卡死同步；真正的缺口仍然拒绝', () => {
  const mk = (id, numbers) => sample(id, numbers, 1, { date: '2026-01-01' });
  const current = normalizeSource(source([mk('2026-320')], '2026-320')).records;
  // 2026-322 开出重号 → 上游自己判为无效，序列里留下空洞
  const withBad = source([mk('2026-320'), mk('2026-321', [7, 8, 9, 10, 11, 12]), mk('2026-322', [5, 5, 5, 5, 5, 5]), mk('2026-323', [13, 14, 15, 16, 17, 18])], '2026-323');
  const merged = mergeSource(current, withBad);
  assert.equal(merged.added, 2, '坏期前后的合法期次都要写进来');
  assert.deepEqual(merged.skippedInvalid, ['2026-322']);
  assert.equal(merged.records.at(-1).label, '2026-323');
  assert.equal(merged.records.some(r => r.label === '2026-322'), false);
  // 上游没说无效、单纯少一期 → 仍然拒绝，不静默接上
  const realGap = source([mk('2026-320'), mk('2026-321', [7, 8, 9, 10, 11, 12]), mk('2026-323', [13, 14, 15, 16, 17, 18])], '2026-323');
  assert.throws(() => mergeSource(current, realGap), /缺口/);
  // 落后源改成带 code 的异常，调用方按 code 分流而不是匹配中文文案
  assert.throws(() => mergeSource(merged.records, source([mk('2026-320')], '2026-320')), e => e.code === 'STALE_SOURCE' && /落后/.test(e.message));
});

test('期号提示分清「超出年期内」与「序号没写三位」', () => {
  const seven = [3, 11, 22, 35, 41, 48, 7];
  // 旧实现对 2026-31 回「2026 年最多 365 期」，而 31 < 365，解释不通
  assert.match(validateManualDraw('2026-31', seven, records).error, /序号需三位，应写 2026-031/);
  assert.match(validateManualDraw('2026-999', seven, records).error, /2026 年最多 365 期/);
  assert.match(validateManualDraw('2024-31', seven, records).error, /序号需三位，应写 2024-031/);
});

test('修改最后一条手动记录：录错一个号不必整条撤销重来', () => {
  const { record } = validateManualDraw('2026-327', [3, 11, 22, 35, 41, 48, 7], records);
  const next = appendManualDraw(records, record);
  // 修改模式：期号必须是当前最新一期，且那一条得是手动补录
  const fixed = validateManualDraw('2026-327', [3, 11, 22, 35, 41, 48, 9], next, { mode: 'replace' });
  assert.equal(fixed.error, undefined);
  const done = replaceLastManual(next, fixed.record);
  assert.equal(done.records.length, next.length);
  assert.equal(done.records.at(-1).special, 9);
  assert.equal(done.replaced.special, 7);
  assert.equal(done.records.at(-1).manual, true);
  assert.equal(undoLastManual(done.records).removed.special, 9, '改完仍能撤销');
  // 不能借「修改」改期号
  assert.match(validateManualDraw('2026-328', [3, 11, 22, 35, 41, 48, 9], next, { mode: 'replace' }).error, /不能改期号/);
  // 非手动的最新一期不允许在这里改
  assert.match(validateManualDraw('2026-326', [3, 11, 22, 35, 41, 48, 9], records, { mode: 'replace' }).error, /不是手动补录/);
  assert.throws(() => replaceLastManual(records, fixed.record), /没有可修改/);
  // 手动记录后面接了新期次时不许改，否则对不上账
  const withNewer = next.concat([{ year: 2026, periodNum: 328, label: '2026-328', date: '2026-11-24', numbers: [1, 2, 3, 4, 5, 6], special: 9 }]);
  assert.throws(() => replaceLastManual(withNewer, fixed.record), /之后已有新期次/);
});

test('跟号账本：按用户自己的跟号起点累计投入、返奖、盈亏与回本缺口', () => {
  const led = followLedger(replay, '2026-01-01');
  assert.equal(led.active, true);
  assert.equal(led.periods, 326);
  assert.equal(led.firstLabel, '2026-001');
  assert.equal(led.lastLabel, '2026-326');
  assert.equal(led.cost, 326 * COST_PER_PERIOD);
  assert.equal(led.prize, led.groups * PRIZE_PER_GROUP);
  assert.equal(led.net, led.prize - led.cost);
  assert.equal(led.net >= 0 ? led.groupsToBreakEven : Math.ceil(-led.net / PRIZE_PER_GROUP), led.groupsToBreakEven);
  assert.equal(led.specialWins, replay.slice(-326).filter(r => r.specialHit === true).length);
  // 期望奖金：用来判断这段区间的实际盈亏是手气还是抽水
  assert.ok(Math.abs(led.expectedPrize - 326 * EXPECTED_PRIZE_PER_PERIOD) < 1e-6);
  // 未设起点 / 起点晚于全部数据
  assert.equal(followLedger(replay, ''), null);
  assert.deepEqual(followLedger(replay, '2030-01-01'), { active: false, periods: 0 });
  // 起点之后的区间一定更短
  assert.ok(followLedger(replay, '2026-06-01').periods < led.periods);
  // 载荷里带 followSince，且能被 normalizeSource 忽略
  const payload = storagePayload(records, '2026-11-23', base.invalid, { followSince: '2026-01-01' });
  assert.equal(payload.followSince, '2026-01-01');
  assert.equal(storagePayload(records, '2026-11-23', base.invalid).followSince, undefined);
  assert.equal(normalizeSource(payload).records.length, records.length);
});

test('日期工具：判断本机数据是否落后于今天', () => {
  assert.equal(engine.daysBetween('2026-11-17', '2026-11-23'), 6);
  assert.equal(engine.daysBetween('2026-11-23', '2026-11-23'), 0);
  assert.equal(engine.daysBetween('2026-11-23', '2026-11-17'), -6);
  assert.equal(engine.daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(engine.daysBetween('2026-11-23', '坏日期'), null);
  assert.match(engine.todayUTC('2026-11-23T05:00:00Z'), /^2026-11-23$/);
  assert.match(engine.todayUTC(), /^\d{4}-\d{2}-\d{2}$/);
});
