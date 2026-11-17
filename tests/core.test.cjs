'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../src/engine.js');
const {normalizeSource,mergeSource,buildReplay}=require('../src/data.js');
const snapshot=require('../data/draws.json');
const source = (records, latestId) => ({updatedAt:'2026-11-17',latestId,draws:records});
const sample=(id,numbers=[1,2,3,4,5,6])=>({id,date:'2026-11-17',numbers,special:49});

test('来源数据取前6码、过滤无效期及保持有效历史',()=>{
 const result=normalizeSource(snapshot);
 assert.equal(result.records.length,1780); assert.deepEqual(result.invalid,['2022-132']);
 assert.equal(result.records.at(-1).label,'2026-320');
 assert.deepEqual(result.records.at(-1).numbers,[14,17,32,34,24,46]);
 assert.equal('special' in result.records.at(-1),false);
 assert.throws(()=>normalizeSource(source([sample('2026-321',[1,1,2,3,4,5])],'2026-321')),/没有有效|无效/);
});

test('附件7码算法、35组合和命中数量',()=>{
 const records=normalizeSource(snapshot).records;
 const p=engine.parseLabel(engine.nextLabelOf(records.at(-1).label));
 const rec=engine.run3in3At(records,records.length,p.year,p.periodNum,engine.periodToDate(p.year,p.periodNum));
 assert.equal(rec.opt.length,7); assert.equal(new Set(rec.opt).size,7);
 assert.ok(rec.opt.every(n=>n>=1&&n<=49));
 const groups=engine.buildAll35Triples(rec.opt);
 assert.equal(groups.length,35); assert.equal(new Set(groups).size,35);
 assert.deepEqual([0,1,2,3,4,5,6].map(engine.countTriples),[0,0,0,1,4,10,20]);
});

test('回放使用同期之前的有效记录，不将不足7码伪装成复式',()=>{
 const records=normalizeSource(snapshot).records;
 const history=buildReplay(records);
 assert.equal(history.length,1778);
 assert.ok(history.every(r=>r.recommended.length===7));
 for(const r of [history[0],history[100],history.at(-1)]){
   const i=records.findIndex(x=>x.label===r.label);
   const before=records.slice(0,i);
   const expected=engine.run3in3At(before,before.length,r.year,r.periodNum,r.date).opt;
   assert.deepEqual(r.recommended,expected);
   assert.equal(r.triples,engine.countTriples(expected.filter(n=>r.numbers.includes(n)).length));
 }
 const altered=records.slice(); altered[100]={...altered[100],numbers:[1,2,3,4,5,6]};
 const original=buildReplay(records.slice(0,150)).find(r=>r.label===records[100].label);
 const changed=buildReplay(altered.slice(0,150)).find(r=>r.label===records[100].label);
 assert.deepEqual(changed.recommended,original.recommended);
});

test('同步只追加连续有效数据，冲突、缺口、落后源不写入',()=>{
 const current=normalizeSource(snapshot).records;
 const extra=sample('2026-321');
 const updated=source([...snapshot.draws,extra],'2026-321');
 const res=mergeSource(current,updated);
 assert.equal(res.added,1); assert.equal(res.records.at(-1).label,'2026-321');
 assert.equal(current.at(-1).label,'2026-320');
 assert.throws(()=>mergeSource(current,source([...snapshot.draws,sample('2026-322')],'2026-322')),/缺口/);
 const conflict=snapshot.draws.map(d=>d.id==='2026-320'?{...d,numbers:[1,2,3,4,5,6]}:d);
 assert.throws(()=>mergeSource(current,source(conflict,'2026-320')),/冲突/);
 assert.throws(()=>mergeSource(res.records,snapshot),/落后/);
});
