'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const snapshot=require('../data/draws.json');
function setup(remote){
  const elems=new Map(), store=new Map([['kl8_manual_draws_v1','sensitive'],['kl8_recommended_budget_v1','10'],['other_app','keep']]);
  const get=id=>{if(!elems.has(id)){const e={id,textContent:'',innerHTML:'',disabled:false,style:{},events:{},addEventListener(name,fn){this.events[name]=fn;},querySelectorAll(){return[];},remove(){},select(){}};elems.set(id,e);}return elems.get(id);};
  const document={getElementById:get,createElement:get,body:{append(){}},execCommand(){return true;}};
  const storage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  const clipboard=[];
  const sandbox={document,localStorage:storage,navigator:{clipboard:{writeText:async text=>clipboard.push(text)}},location:{protocol:'http:'},fetch:async url=>({ok:true,json:async()=>String(url).startsWith('http')?remote:snapshot}),setTimeout:()=>0,console};
  vm.createContext(sandbox);
  for(const f of ['src/engine.js','src/data.js','src/app.js'])vm.runInContext(fs.readFileSync(f,'utf8'),sandbox,{filename:f});
  return {sandbox,get,store,clipboard};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('页面初始化、清除旧快乐8数据、复制推荐及同步新期',async()=>{
 const extra={id:'2026-321',date:'2026-11-17',numbers:[1,2,3,4,5,6],special:49};
 const ctx=setup({...snapshot,latestId:'2026-321',draws:[extra,...snapshot.draws]});
 await flush();
 assert.equal(ctx.get('latestIssue').textContent,'2026-320');
 assert.equal(ctx.get('targetIssue').textContent,'2026-321');
 assert.equal(ctx.store.has('kl8_manual_draws_v1'),false);
 assert.equal(ctx.store.has('kl8_recommended_budget_v1'),false);
 assert.equal(ctx.store.get('other_app'),'keep');
 await ctx.get('copyBtn').events.click();
 assert.match(ctx.clipboard[0],/2026-321期 · 7码复式（35组）/);
 await ctx.get('syncBtn').events.click();
 assert.equal(ctx.get('latestIssue').textContent,'2026-321');
 assert.equal(ctx.get('targetIssue').textContent,'2026-322');
 assert.match(ctx.get('syncStatus').textContent,/新增 1 期/);
 assert.equal(JSON.parse(ctx.store.get('three_in_three_sync_v1')).draws.at(-1).numbers.length,6);
 assert.equal(ctx.get('syncBtn').disabled,false);
});

test('页面同步冲突时不修改本机数据或推荐期号',async()=>{
 const conflict=snapshot.draws.map(d=>d.id==='2026-320'?{...d,numbers:[1,2,3,4,5,6]}:d);
 const ctx=setup({...snapshot,draws:conflict}); await flush();
 await ctx.get('syncBtn').events.click();
 assert.match(ctx.get('syncStatus').textContent,/冲突/);
 assert.equal(ctx.get('latestIssue').textContent,'2026-320');
 assert.equal(ctx.store.has('three_in_three_sync_v1'),false);
});


test('历史回放显示单期投入、中奖返奖、累计盈亏及逐期奖金',async()=>{
 const ctx=setup(snapshot); await flush();
 const summary=ctx.get('summary').innerHTML;
 assert.match(summary,/有奖期占比/);
 assert.match(summary,/35 组 × 2 元 = 70 元/);
 assert.match(summary,/2 元 × 700 = 1,400 元/);
 assert.match(summary,/模拟盈亏/);
 assert.match(ctx.get('historyBody').innerHTML,/¥(?:0|1400|5600|14000|28000)/);
});
