'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine.js');
const {
  normalizeSource, mergeSource, buildReplay, summarizeReplay, summarizeSpecial,
  normalizeSpecial, parsePastedNumbers, validateManualDraw, appendManualDraw,
  undoLastManual, manualRecords, storagePayload,
  COST_PER_PERIOD, PRIZE_PER_GROUP, SPECIAL_BASELINE_RATE
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

test('特码只做记录：无效特码归为未记录，且不影响 7 码方案', () => {
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
  // 把每一期特码整体改动，逐期方案必须一字不差
  const mutated = records.map(r => ({ ...r, special: ((r.special || 1) % 49) + 1 }));
  const mutatedReplay = buildReplay(mutated.slice(0, 400));
  const originalReplay = buildReplay(records.slice(0, 400));
  assert.equal(mutatedReplay.length, originalReplay.length);
  for (let i = 0; i < mutatedReplay.length; i++) {
    assert.deepEqual(mutatedReplay[i].recommended, originalReplay[i].recommended, mutatedReplay[i].label + ' 方案受特码影响');
    assert.deepEqual(mutatedReplay[i].hits, originalReplay[i].hits);
    assert.equal(mutatedReplay[i].triples, originalReplay[i].triples);
  }
});

test('附件7码算法、35组合和命中数量', () => {
  const p = engine.parseLabel(engine.nextLabelOf(records.at(-1).label));
  const rec = engine.run3in3At(records, records.length, p.year, p.periodNum, engine.periodToDate(p.year, p.periodNum));
  assert.equal(rec.opt.length, 7);
  assert.equal(new Set(rec.opt).size, 7);
  assert.ok(rec.opt.every(n => n >= 1 && n <= 49));
  const groups = engine.buildAll35Triples(rec.opt);
  assert.equal(groups.length, 35);
  assert.equal(new Set(groups).size, 35);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(engine.countTriples), [0, 0, 0, 1, 4, 10, 20]);
  assert.equal(engine.zodiacOfNumber(43, '2026-11-20'), '鼠');
  assert.equal(engine.WAVE_MAP[43], 'green');
});

test('回放逐期只使用同期之前的记录，并同时给出三中三与特码命中', () => {
  assert.equal(replay.length, 1784);
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

test('三中三金额口径不变：每注2元、中奖总返奖700倍', () => {
  const rows = [0, 1, 4, 10, 20].map(triples => ({ triples }));
  const stats = summarizeReplay(rows);
  assert.deepEqual(stats, {
    periods: 5, winningPeriods: 4, groups: 35, cost: 350, prize: 49000, net: 48650,
    winningRate: 80, returnRate: 14000
  });
  assert.deepEqual(summarizeReplay([]), { periods: 0, winningPeriods: 0, groups: 0, cost: 0, prize: 0, net: 0, winningRate: 0, returnRate: 0 });
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
