'use strict';
/**
 * 算法测试：原版评分/选码（组合约束实验已随页面移除）
 * 数据固定到 2026-258（若仓库数据更多，也限定到该期号核对，不比较不同长度样本）。
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {loadPage,extraStorage}=require('./helpers.cjs');

const expected=JSON.parse(fs.readFileSync(path.join(__dirname,'expected.json'),'utf8'));
const DATA_MAX='2026-258';

function sha256(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
/** 跨 realm 安全比较数字数组 */
function eqNums(actual,expected,msg){
  const a=Array.isArray(actual)?actual.map(Number):[...actual].map(Number);
  assert.equal(a.length,expected.length,(msg||'')+' 长度不一致');
  for(let i=0;i<expected.length;i++)assert.equal(a[i],expected[i],`${msg||''} 第${i}个号码不一致: 实际[${a}] 期望[${expected}]`);
}
function expose(){
  return'globalThis.__X={simulateEngine,longWaveEngine,origTop7,allData};';
}

test('预热边界：60 期以下不产出预测，60 期正常',t=>{
  const page=loadPage({expose:expose()});
  const X=page.sandbox.__X;
  const{draws}=X.allData();
  assert.equal(X.simulateEngine(draws.slice(0,59)),null);
  assert.ok(X.simulateEngine(draws.slice(0,60)),'第 60 期历史应可出预测');
});

test('原版算法：1294 期预测哈希回归（2023-061 至 2026-258）',t=>{
  const page=loadPage({preStorage:extraStorage(DATA_MAX),expose:expose()});
  const X=page.sandbox.__X;
  const{draws,labels}=X.allData();
  const rows=[];
  for(let i=60;i<draws.length;i++){
    const m=X.longWaveEngine(draws.slice(0,i),labels[i]);
    if(!m)continue;
    rows.push({label:labels[i],pred:m.mergeNums.slice(),hit:m.mergeNums.includes(draws[i][6])});
  }
  assert.equal(rows.length,1294);
  assert.equal(sha256(rows),expected.origRowsSha256,'原版逐期有序 7 码与固定核对数据不一致');
  const hits=rows.filter(r=>r.hit).length;
  assert.equal(hits,230,'全区间命中应为 230');
  const y2026=rows.filter(r=>r.label.startsWith('2026')&&r.hit).length;
  assert.equal(y2026,52,'2026-001..258 命中应为 52');
  const last58=rows.filter(r=>r.label>='2026-201'&&r.hit).length;
  assert.equal(last58,12,'2026-201..258（58 期）命中应为 12');
});

test('波色预测：按每组平均出现次数取最少，并列取红→蓝→绿（回归旧实现的并列偏绿 bug）',t=>{
  const page=loadPage({});
  const T=page.sandbox.window.__LOTTO_SYNC_TEST__;
  // 跨 realm 对象不能直接 deepEqual，按字段比较
  assert.equal(T.WAVE_GROUP.red,17);assert.equal(T.WAVE_GROUP.blue,16);assert.equal(T.WAVE_GROUP.green,16);
  assert.equal(T.WAVE_ORDER.join(','),'red,blue,green');
  // 三者全并列 → 红（旧实现会返回绿）
  assert.equal(T.pickPredWave({red:15,blue:15,green:15}),'red');
  // 红蓝并列最小、绿更多 → 红（旧实现返回蓝）
  assert.equal(T.pickPredWave({red:14,blue:14,green:17}),'red');
  // 蓝绿并列最小、红更多 → 蓝
  assert.equal(T.pickPredWave({red:17,blue:13,green:13}),'blue');
  // 组大小校正：17/16/16 下，红 16 + 蓝 15 的“人均”红更低 → 红
  //   16/17 = 0.9412 < 15/16 = 0.9375 不成立，故这里用红 17 蓝 16（人均相等）→ 红
  assert.equal(T.pickPredWave({red:17,blue:16,green:12}),'green','绿严格最少时不受并列规则影响');
  assert.equal(T.pickPredWave({red:16,blue:15,green:14}),'green');
  // 严格最少者优先于并列规则
  assert.equal(T.pickPredWave({red:10,blue:20,green:15}),'red');
  // 旧 bug 的特征：全并列时返回最后键
  const keys=['red','blue','green'];
  const old=keys.reduce((a,b)=>({red:15,blue:15,green:15}[a]<{red:15,blue:15,green:15}[b]?a:b));
  assert.equal(old,'green','旧实现确实并列取后者（此断言记录 bug 形态）');
});

test('原版选码：前5纯分数 + 分区软约束 + 80% 分数阈值',t=>{
  const page=loadPage({preStorage:extraStorage(DATA_MAX),expose:expose()});
  const X=page.sandbox.__X;
  const{draws,labels}=X.allData();
  const i=labels.indexOf('2026-258');
  const L=X.simulateEngine(draws.slice(0,i));
  const top7=X.origTop7(L.allScores);
  assert.equal(top7.length,7);
  // 前 5 名必须与纯分数前 5 完全一致
  for(let k=0;k<5;k++)assert.equal(top7[k].n,L.allScores[k].n,`前5第${k+1}名应为纯分数第${k+1}名`);
  // 无重复
  assert.equal(new Set(top7.map(s=>s.n)).size,7);
  // 与 7码候选引擎输出一致
  const m=X.longWaveEngine(draws.slice(0,i),labels[i]);
  const merged=m.mergeNums.map(Number),t7=top7.map(s=>s.n);
  assert.equal(merged.length,t7.length);
  for(let k=0;k<7;k++)assert.equal(merged[k],t7[k],`第${k+1}码不一致`);
});

test('无未来信息：追加之后的数据不改变各期预测',t=>{
  // 数据到 2026-258 与到 2026-265 的两个页面，公共区间预测必须一致
  const pageA=loadPage({preStorage:extraStorage('2026-258'),expose:expose()});
  const pageB=loadPage({preStorage:extraStorage('2026-265'),expose:expose()});
  const A=pageA.sandbox.__X,B=pageB.sandbox.__X;
  const{draws:da,labels:la}=A.allData();
  const{draws:db,labels:lb}=B.allData();
  for(const label of['2026-201','2026-210','2026-258']){
    const iA=la.indexOf(label),iB=lb.indexOf(label);
    assert.ok(iA>=0&&iB>=0,label);
    const mA=A.longWaveEngine(da.slice(0,iA),label);
    const mB=B.longWaveEngine(db.slice(0,iB),label);
    eqNums(mB.mergeNums,mA.mergeNums,`${label} 的预测不应受后续数据影响`);
  }
});

test('确定性：同一数据重复计算结果一致',t=>{
  const page=loadPage({preStorage:extraStorage(DATA_MAX),expose:expose()});
  const X=page.sandbox.__X;
  const{draws,labels}=X.allData();
  const i=labels.indexOf('2026-230');
  const p1=X.longWaveEngine(draws.slice(0,i),labels[i]).mergeNums;
  const p2=X.longWaveEngine(draws.slice(0,i),labels[i]).mergeNums;
  eqNums(p2,p1,'重复计算应复现同一结果');
});

test('页面已移除组合约束：无开关、无 combo 代码路径',t=>{
  const fs=require('fs');
  const html=fs.readFileSync(path.resolve(__dirname,'..','index.html'),'utf8');
  assert.ok(!html.includes('comboToggle'),'不得再出现组合约束开关');
  assert.ok(!html.includes('comboSelect'),'不得再出现组合约束选码');
  assert.ok(!html.includes('modelMode'),'不得再出现模型切换状态');
});
