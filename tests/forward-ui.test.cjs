'use strict';
/**
 * 前瞻验证（Section 6）：界面交互、缓存失效、蒙特卡洛随机对照
 * 数据固定到 2026-258 核对。
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadPage,extraStorage,hooks,waitForForward,sleep}=require('./helpers.cjs');

const DATA_MAX='2026-258';

function newPage(){
  const page=loadPage({preStorage:extraStorage(DATA_MAX)});
  page.fireLoad();
  return page;
}

test('前瞻明细表只有 4 列（期号/预测7码/实际特码/7码命中），不恢复单双大小波色回测列',async t=>{
  const fs=require('fs');
  const path=require('path');
  const html=fs.readFileSync(path.resolve(__dirname,'..','index.html'),'utf8');
  const m=html.match(/<table class="history"><thead><tr>((?:(?!<\/tr>)[\s\S])*?)<\/tr><\/thead><tbody id="fwdBody">/);
  assert.ok(m,'未找到前瞻明细表');
  const ths=[...m[1].matchAll(/<th[^>]*>[\s\S]*?<\/th>/g)].map(x=>x[0]);
  assert.equal(ths.length,4,`前瞻明细表应为 4 列，实际 ${ths.length}`);
  const heads=ths.map(x=>x.replace(/<[^>]+>/g,'').trim());
  assert.deepEqual(heads,['期号','当期预测 7 码','实际特码','7码命中']);
  // 页面不得再出现前瞻回测列的旧表头
  assert.ok(!/前瞻.*单双|前瞻.*大小|前瞻.*波色命中/.test(html));
});

test('默认起算期 2026-201：58 期 13 次命中，精确 p=0.0630 → 边缘/不显著',async t=>{
  const page=newPage();
  const T=hooks(page);
  page.el('fwdStart').value='2026-201';
  T.runForward();
  await waitForForward(page);
  const body=page.el('fwdBody').innerHTML;
  assert.equal((body.match(/<tr class=/g)||[]).length,58,'明细应为 58 行');
  assert.equal((body.match(/class="badge hit"/g)||[]).length,13,'命中行应为 13');
  const metrics=page.el('fwdMetrics').innerHTML;
  assert.ok(metrics.includes('0.0630'),`应显示精确 p=0.0630: ${metrics.slice(0,200)}`);
  assert.ok(metrics.includes('边缘 / 不显著（可能为随机波动）'),'应判为边缘/不显著');
  const concl=page.el('fwdConclusion').textContent;
  assert.ok(concl.includes('边缘 / 不显著'),concl);
  assert.ok(!concl.includes('统计上显著高于随机基线'),'不得宣称显著');
});

test('起算期 2026-001：258 期 53 次命中；2023-061：1294 期 230 次命中',async t=>{
  const page=newPage();
  const T=hooks(page);
  page.el('fwdStart').value='2026-001';
  T.runForward();
  await waitForForward(page);
  let body=page.el('fwdBody').innerHTML;
  assert.equal((body.match(/<tr class=/g)||[]).length,258);
  assert.equal((body.match(/class="badge hit"/g)||[]).length,53);
  page.el('fwdStart').value='2023-061';
  T.runForward();
  await waitForForward(page);
  body=page.el('fwdBody').innerHTML;
  assert.equal((body.match(/<tr class=/g)||[]).length,1294);
  assert.equal((body.match(/class="badge hit"/g)||[]).length,230);
});

test('起算期只改变评估范围：各期预测仍使用此前完整历史（不偷看、不截断历史）',async t=>{
  const page=newPage();
  const T=hooks(page);
  page.el('fwdStart').value='2026-001';
  T.runForward();
  await waitForForward(page);
  const res=T.fwdCache.res;
  const first=res.rows.find(r=>r.label==='2026-001');
  assert.ok(first,'明细应包含 2026-001');
  assert.equal(first.pred.length,7);
  // 无未来信息：2026-001 的 7 码必须与"仅用其之前 1296 期历史"的引擎输出一致
  const{draws,labels}=page.sandbox.allData();
  const i=labels.indexOf('2026-001');
  const m=page.sandbox.longWaveEngine(draws.slice(0,i),'2026-001');
  assert.deepEqual(first.pred,m.mergeNums,'起算期内的预测必须只使用该期之前的完整历史');
});

test('预热：起算期早于第 61 期时自动从 2023-061 起算并显示有效区间',async t=>{
  const page=newPage();
  const T=hooks(page);
  page.el('fwdStart').value='2023-010';
  T.runForward();
  await waitForForward(page);
  const range=page.el('fwdRange').textContent;
  assert.ok(range.includes('2023-061'),`有效区间应从 2023-061 开始: ${range}`);
  assert.equal((page.el('fwdBody').innerHTML.match(/<tr class=/g)||[]).length,1294);
});

test('输入框与滑块双向同步',async t=>{
  const page=newPage();
  const T=hooks(page);
  const slider=page.el('fwdSlider'),input=page.el('fwdStart');
  T.refreshSliderRange();
  const{labels}=page.sandbox.allData();
  // 滑块 → 输入框
  slider.value=String(labels.indexOf('2026-001'));
  slider.dispatch('input');
  assert.equal(input.value,'2026-001','滑块应同步到输入框');
  assert.equal(page.el('fwdSliderLabel').textContent,'2026-001');
  // 输入框 → 滑块
  input.value='2026-220';
  input.dispatch('input');
  assert.equal(slider.value,String(labels.indexOf('2026-220')),'输入框应同步到滑块');
  assert.equal(page.el('fwdSliderLabel').textContent,'2026-220');
});

test('起算期错误/超范围：明确报错，不静默回退默认起点',async t=>{
  const page=newPage();
  const T=hooks(page);
  const input=page.el('fwdStart');
  input.value='2027-999';
  T.runForward();
  await waitForForward(page);
  assert.ok(page.el('fwdBody').innerHTML.includes('起算期无效'),'非法格式应报错');
  input.value='2026-300';
  T.runForward();
  await waitForForward(page);
  assert.ok(page.el('fwdBody').innerHTML.includes('数据中没有'),'超出数据范围应报错');
});

test('前瞻缓存：同一数据/区间不重算；任一变化即失效',async t=>{
  const page=newPage();
  const T=hooks(page);
  const input=page.el('fwdStart');
  input.value='2026-201';
  T.runForward();
  await waitForForward(page);
  await page.waitFor(()=>T.fwdCache.res&&T.fwdCache.res.rows&&T.fwdCache.res.rows.length===58,15000);
  const first=T.fwdCache.res;
  assert.match(T.fwdCache.key,/2026-201$/,'缓存键应包含起算期');
  // 重复运行 → 命中同一缓存对象
  T.runForward();
  await sleep(300);
  assert.equal(T.fwdCache.res,first,'相同键应复用缓存');
  // 切换起算期 → 新缓存
  input.value='2026-001';
  T.runForward();
  await page.waitFor(()=>T.fwdCache.res!==first&&T.fwdCache.res.rows&&T.fwdCache.res.rows.length===258,15000);
  assert.match(T.fwdCache.key,/2026-001$/,'区间变化应重算并更新缓存键');
  // 回到原起算期 → 复用与最初一致的确定性结果
  input.value='2026-201';
  T.runForward();
  await page.waitFor(()=>T.fwdCache.key&&T.fwdCache.key.endsWith('2026-201')&&T.fwdCache.res&&T.fwdCache.res.rows&&T.fwdCache.res.rows.length===58,15000);
  const againRows=T.fwdCache.res.rows.map(r=>[...r.pred].map(Number));
  assert.deepEqual(againRows,first.rows.map(r=>[...r.pred].map(Number)),'同区间重复计算应复现相同预测');
});

test('数据变化（撤销/追加）使前瞻缓存与滑块边界失效',async t=>{
  const page=newPage();
  const T=hooks(page);
  const input=page.el('fwdStart');
  input.value='2026-201';
  T.runForward();
  await waitForForward(page);
  await page.waitFor(()=>T.fwdCache.res&&T.fwdCache.res.rows&&T.fwdCache.res.rows.length===58,15000);
  const before=T.fwdCache.res;
  const beforeKey=T.fwdCache.key.split('|')[0];
  // 模拟"追加一期"：走页面的 validateManual 通道（localStorage 预置数据）不现实，
  // 这里直接调用页面暴露的 applyPlan 等价路径：通过 planAppend+applyPlan 追加 2026-259
  const plan=T.planAppend([{label:'2026-259',year:2026,period:259,date:'',nums:[1,2,3,4,5,6,7],special:7}]);
  assert.equal(plan.append.length,1,'应可追加 2026-259');
  const result=T.applyPlan(plan);
  assert.ok(result.ok&&result.wrote===1);
  await page.waitFor(()=>T.fwdCache.res&&T.fwdCache.res!==before&&T.fwdCache.res.rows&&T.fwdCache.res.rows.length===59,15000);
  assert.ok(T.fwdCache.key.split('|')[0]!==(beforeKey), '数据版本变化后缓存键应不同');
  const slider=page.el('fwdSlider');
  assert.equal(String(slider.max),String(1354),'滑块上界应随数据扩展（原 1353 → 1354）');
});

test('蒙特卡洛：确定性 PRNG、可完成、经验 p 与精确 p 一致在模拟误差内',async t=>{
  const page=newPage();
  const T=hooks(page);
  // PRNG 确定性
  const a=T.mulberry32(42),b=T.mulberry32(42);
  assert.deepEqual([a(),a(),a()],[b(),b(),b()]);
  // 完整运行 10,000 次对照（N=58, K=13）
  T.runMonteCarlo(58,13);
  await page.waitFor(()=>!T.mc.running,30000);
  const body=page.el('mcBody').innerHTML;
  const status=page.el('mcStatus').textContent;
  assert.ok(status.includes('完成'),`应完成: ${status}`);
  assert.ok(body.includes('随机种子'),'应显示种子');
  assert.ok(body.includes('Wilson'),'应显示模拟误差区间');
  const m=body.match(/超过 13 次的模拟\s*<\/small>\s*<b[^>]*>(\d+)/);
  assert.ok(m,'应显示超过次数');
  const geq=+m[1];
  const pe=geq/10000;
  const exact=T.binomRightTail(58,13);
  const sigma=Math.sqrt(exact*(1-exact)/10000);
  assert.ok(Math.abs(pe-exact)<=5*sigma,`经验 p=${pe} 应落在精确 p=${exact} 的 5σ 模拟误差内`);
  // 无样本 → 不运行
  T.runMonteCarlo(0,0);
  assert.ok(page.el('mcStatus').textContent.includes('无样本'));
});

test('蒙特卡洛：新任务启动时取消旧任务并清空结果',async t=>{
  const page=newPage();
  const T=hooks(page);
  T.runMonteCarlo(258,53); // 大 N，运行较慢
  await sleep(20);
  assert.ok(T.mc.running||T.mc.token,'任务应已启动');
  const oldToken=T.mc.token;
  // 新对照任务（等价于区间/数据变化后的自动重算）→ 旧任务立即取消并清空
  T.runMonteCarlo(58,10);
  assert.ok(oldToken.cancelled,'旧任务应被立即标记取消');
  assert.ok(T.mc.running,'新对照任务应已启动');
  // 新对照完成：N=58, K=10
  await page.waitFor(()=>page.el('mcStatus').textContent.includes('完成'),60000);
  assert.ok(page.el('mcBody').innerHTML.includes('超过 10 次'),'新对照应按新参数（K=10）运行');
});

test('页面不显示模型版本号；规则名静态标注为"原评分＋原选码"',async t=>{
  const fs=require('fs');
  const path=require('path');
  const html=fs.readFileSync(path.resolve(__dirname,'..','index.html'),'utf8');
  assert.ok(!/v3\.\d/.test(html),'页面/内联代码不得出现模型版本号 v3.x');
  assert.ok(html.includes('<h2>2. 7码候选 <span class="tag">原评分＋原选码</span></h2>'),'规则名应为静态标注"原评分＋原选码"');
  assert.ok(!html.includes('组合约束'),'页面不得再出现组合约束相关文案');
});
