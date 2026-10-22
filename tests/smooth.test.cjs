'use strict';
/**
 * 自动降档省钱助手：均值回归 + 亏损平滑终极版算法规则
 * 规则：亏损平滑基础档 / 破限冷号降档 / 过热失衡避险（连中≥3 或近10期命中≥4）/ 黄金破冰窗（连空 8–9、12–13、18–19）
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadPage,extraStorage}=require('./helpers.cjs');

function hooksPage(){
  const page=loadPage();
  return page.sandbox.window.__LOTTO_SYNC_TEST__;
}

test('基础档位：连空 0–1 满注 / 2–3 半注 / ≥4 底注，且低于破冰窗时为底注防守',async t=>{
  const T=hooksPage();
  const sig=(miss,extra={})=>T.smSignalFor(Object.assign({missStreak:miss,hitStreak:0,hitsLast10:0},extra),false);
  assert.equal(sig(0).tier,'L1');
  assert.equal(sig(1).tier,'L1');
  assert.equal(sig(2).tier,'L2');
  assert.equal(sig(3).tier,'L2');
  assert.equal(sig(4).tier,'L3');
  assert.equal(sig(7).tier,'L3');
  assert.equal(sig(7).signalName,'底注防守');
  assert.equal(sig(0).signalName,'正常');
  assert.equal(sig(0).baseTier,'L1','rawTier 应记录未被降档的基础档');
});

test('破限冷号：仅满注档自动降一档（L1→L2），其余档位不重复降档',async t=>{
  const T=hooksPage();
  const broken=(miss)=>T.smSignalFor({missStreak:miss,hitStreak:0,hitsLast10:0},true);
  assert.equal(broken(0).cappedByBroken,true);
  assert.equal(broken(0).tier,'L2');
  assert.equal(broken(1).tier,'L2');
  assert.equal(broken(2).cappedByBroken,false);
  assert.equal(broken(2).tier,'L2');
  assert.equal(broken(4).cappedByBroken,false);
  assert.equal(broken(4).tier,'L3');
});

test('过热失衡避险：连中≥3 期或近 10 期命中≥4 次自动降一档',async t=>{
  const T=hooksPage();
  const base={missStreak:0,hitStreak:0,hitsLast10:0};
  const hit2=T.smSignalFor(Object.assign({},base,{hitStreak:2,hitsLast10:2}),false);
  assert.equal(hit2.hotAvoid,false,'连中 2 期不应触发');
  assert.equal(hit2.tier,'L1');
  const hit3=T.smSignalFor(Object.assign({},base,{hitStreak:3,hitsLast10:3}),false);
  assert.equal(hit3.hotAvoid,true);
  assert.equal(hit3.tier,'L2','连中 3 期应降一档');
  assert.equal(hit3.signalName,'过热避险');
  const h10=T.smSignalFor(Object.assign({},base,{hitStreak:1,hitsLast10:4}),false);
  assert.equal(h10.hotAvoid,true);
  assert.equal(h10.tier,'L2','近 10 期命中 4 次应降一档');
  const h10L2=T.smSignalFor({missStreak:2,hitStreak:0,hitsLast10:4},false);
  assert.equal(h10L2.tier,'L3','半注档遇过热再降一档到底注');
  const h10L3=T.smSignalFor({missStreak:5,hitStreak:0,hitsLast10:4},false);
  assert.equal(h10L3.tier,'L3','底注档不会降到不存在的档位');
  assert.equal(h10L3.signalName,'过热避险');
});

test('三大黄金破冰窗：连空 8–9 / 12–13 / 18–19 期从底注升半注狙击，其余期数不升',async t=>{
  const T=hooksPage();
  const sig=(miss)=>T.smSignalFor({missStreak:miss,hitStreak:0,hitsLast10:0},false);
  for(const [miss,want] of [[8,'8–9'],[9,'8–9'],[12,'12–13'],[13,'12–13'],[18,'18–19'],[19,'18–19']]){
    const s=sig(miss);
    assert.equal(s.iceBreak,true,`连空 ${miss} 期应进入破冰窗`);
    assert.equal(s.iceWindow,want);
    assert.equal(s.baseTier,'L3');
    assert.equal(s.tier,'L2',`连空 ${miss} 期应升为半注`);
    assert.equal(s.signalName,'破冰狙击');
  }
  for(const miss of[6,7,10,11,14,15,16,17,20,21]){
    const s=sig(miss);
    assert.equal(s.iceBreak,false,`连空 ${miss} 期不在破冰窗内`);
    assert.equal(s.tier,'L3');
  }
  // 破冰窗优先级高于底注防守，且不与过热冲突（连空≥8 期不可能近10期命中≥4）
  assert.equal(sig(8).hotAvoid,false);
});

test('真实数据：2026-221 连空 8 期破冰狙击；2026-254 破限冷号单独降到半注',async t=>{
  const ice=loadPage({preStorage:extraStorage('2026-220'),expose:'refresh();globalThis.__PLAN=calcSmoothPlan(lastEngineState.p);'});
  const icePlan=ice.sandbox.__PLAN;
  assert.equal(icePlan.missStreak,8);
  assert.equal(icePlan.activeTier,'L2');
  assert.equal(icePlan.iceBreak,true);
  assert.equal(icePlan.signalName,'破冰狙击');
  const iceBanner=ice.el('smBanner').innerHTML.replace(/<[^>]+>/g,'');
  assert.ok(iceBanner.includes('破冰窗狙击'));
  assert.ok(iceBanner.includes('主力码买 4 元 / 陪跑码买 2 元（7个号共花 26 元）'));

  const broken=loadPage({preStorage:extraStorage('2026-254'),expose:'refresh();globalThis.__PLAN=calcSmoothPlan(lastEngineState.p);'});
  const brokenPlan=broken.sandbox.__PLAN;
  assert.equal(brokenPlan.rawTier,'L1');
  assert.equal(brokenPlan.cappedByBroken,true);
  assert.equal(brokenPlan.hotAvoid,false);
  assert.equal(brokenPlan.activeTier,'L2');
});

test('真实数据：最新一期 2026-294 已连空 18 期 → 触发 18–19 破冰窗，底注升半注',async t=>{
  const page=loadPage({preStorage:extraStorage('2026-294'),expose:'refresh();globalThis.__PLAN=calcSmoothPlan(lastEngineState.p);'});
  const plan=page.sandbox.__PLAN;
  assert.equal(plan.missStreak,18);
  assert.equal(plan.iceBreak,true);
  assert.equal(plan.iceWindow,'18–19');
  assert.equal(plan.activeTier,'L2');
  assert.equal(plan.totNow,28);
  const banner=page.el('smBanner').innerHTML.replace(/<[^>]+>/g,'');
  assert.ok(banner.includes('破冰窗狙击')&&banner.includes('主力码买 4 元 / 陪跑码买 2 元（7个号共花 28 元）'));
  const foot=page.el('smFoot').innerHTML.replace(/<[^>]+>/g,'');
  assert.ok(foot.includes('2026-201 ~ 2026-294 共 94 期'));
  assert.ok(foot.includes('安全垫 +457 元'));
  assert.ok(foot.includes('省 2937 元'));
});

test('单码角色边界、#6 弱号优先级与最低1元，不修改候选输入',()=>{
  const page=loadPage();
  const role=page.sandbox.smRole;
  for(const sat of [.2,.45,.85,.96,1.05,1.199])assert.equal(role({sat},0),'🚀高爆主力');
  for(const sat of [0,.049,1,1.049])assert.equal(role({sat},0),'⚠️弱势减半');
  for(const sat of [.05,.199,.451,.849,.961,.999])assert.equal(role({sat},0),'🟢常规候选');
  assert.equal(role({sat:.19},5),'⚠️弱势减半');
  assert.equal(role({sat:.2},5),'🚀高爆主力');
  assert.equal(role({sat:1.2},0),'🚨年度钉子户');
  const xs=[{n:1,sat:0},{n:2,sat:.3}],before=JSON.stringify(xs);
  assert.equal(page.sandbox.smAllocate(xs,1)[0].amount,1);
  assert.equal(page.sandbox.smAllocate(xs,5)[0].amount,2.5);
  assert.equal(JSON.stringify(xs),before);
});

test('账单独立逐期复核：只用开奖前候选与状态，按实际命中号码注额返奖',()=>{
  const page=loadPage({preStorage:extraStorage('2026-294'),expose:'refresh();globalThis.audit={flat:archiveCache.flat,plan:calcSmoothPlan(lastEngineState.p)};'});
  const {flat,plan}=page.sandbox.audit;
  let miss=0,hit=0,cost=0,ret=0;
  flat.forEach((r,i)=>{
    const hot=hit>=3||flat.slice(Math.max(0,i-10),i).filter(x=>x.num).length>=4;
    let tier=miss>=4?2:miss>=2?1:0;
    if(tier===0&&r.candidates.some(x=>x.sat>=1))tier=1;
    if(hot)tier=Math.min(2,tier+1);
    if([8,9,12,13,18,19].includes(miss)&&tier===2)tier=1;
    const per=[8,4,2][tier];
    if(r.label>='2026-201')r.candidates.forEach((x,j)=>{
      const weak=x.sat<.05||(x.sat>=1&&x.sat<1.05)||(j===5&&x.sat<.2);
      const amount=weak?Math.max(1,per/2):per;
      cost+=amount;
      if(x.n===r.actual)ret+=amount*48;
    });
    if(r.num){hit++;miss=0;}else{miss++;hit=0;}
  });
  assert.equal(plan.fwdCost,cost);assert.equal(plan.fwdRet,ret);
  assert.equal(plan.fwdNet,ret-cost);
  assert.equal(plan.fwdSaved,94*56-cost);
});
