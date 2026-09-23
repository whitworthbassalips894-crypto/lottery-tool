'use strict';
/**
 * 算法测试：原版评分/选码 + 组合约束（实验开关）
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
  return'globalThis.__X={get modelMode(){return modelMode},set modelMode(v){modelMode=v},simulateEngine,longWaveEngine,origTop7,comboSelect,allData};';
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
  X.modelMode='orig';
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
  assert.equal(y2026,53,'2026-001..258 命中应为 53');
  const last58=rows.filter(r=>r.label>='2026-201'&&r.hit).length;
  assert.equal(last58,13,'2026-201..258（58 期）命中应为 13');
});

test('原版选码：前5纯分数 + 分区软约束 + 80% 分数阈值',t=>{
  const page=loadPage({preStorage:extraStorage(DATA_MAX),expose:expose()});
  const X=page.sandbox.__X;
  X.modelMode='orig';
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
  A.modelMode='orig';B.modelMode='orig';
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

test('模型切换确定性：orig → combo → orig 结果可重复',t=>{
  const page=loadPage({preStorage:extraStorage(DATA_MAX),expose:expose()});
  const X=page.sandbox.__X;
  const{draws,labels}=X.allData();
  const i=labels.indexOf('2026-230');
  X.modelMode='orig';
  const p1=X.longWaveEngine(draws.slice(0,i),labels[i]).mergeNums;
  X.modelMode='combo';
  const p2=X.longWaveEngine(draws.slice(0,i),labels[i]).mergeNums;
  X.modelMode='orig';
  const p3=X.longWaveEngine(draws.slice(0,i),labels[i]).mergeNums;
  eqNums(p3,p1,'切回原版后应复现原版结果');
  assert.notEqual(JSON.stringify(p1),JSON.stringify(p2),'原版与组合约束的 7 码在该期不同');
});

test('组合约束（实验）：1294 期哈希回归 + 命中数固定值',t=>{
  const page=loadPage({preStorage:extraStorage(DATA_MAX),expose:expose()});
  const X=page.sandbox.__X;
  X.modelMode='combo'; // 测试专用 setter：引擎级切换，不触发 UI 重算（UI 流程见 forward-ui 测试）
  const{draws,labels}=X.allData();
  const rows=[];
  for(let i=60;i<draws.length;i++){
    const m=X.longWaveEngine(draws.slice(0,i),labels[i]);
    if(!m)continue;
    rows.push({label:labels[i],pred:m.mergeNums.slice(),hit:m.mergeNums.includes(draws[i][6])});
  }
  assert.equal(rows.length,1294);
  assert.equal(sha256(rows),expected.comboRowsSha256,'组合约束逐期 7 码与固定核对数据不一致');
  const hits=rows.filter(r=>r.hit).length;
  assert.equal(hits,217,'全区间命中应为 217');
  assert.equal(rows.filter(r=>r.label.startsWith('2026')&&r.hit).length,47,'2026 区间命中应为 47');
  assert.equal(rows.filter(r=>r.label>='2026-201'&&r.hit).length,10,'最近 58 期命中应为 10');
});

test('组合约束：每一期输出都满足全部约束且恒为 7 个不同号码',t=>{
  const page=loadPage({preStorage:extraStorage(DATA_MAX),expose:expose()});
  const X=page.sandbox.__X;
  X.modelMode='combo'; // 测试专用 setter：引擎级切换，不触发 UI 重算（UI 流程见 forward-ui 测试）
  const{draws,labels}=X.allData();
  const waveType=n=>{
    const red=[1,2,7,8,12,13,18,19,23,24,29,30,34,35,40,45,46];
    const blue=[3,4,9,10,14,15,20,25,26,31,36,37,41,42,47,48];
    return red.includes(n)?'red':blue.includes(n)?'blue':'green';
  };
  for(let i=60;i<draws.length;i++){
    const m=X.longWaveEngine(draws.slice(0,i),labels[i]);
    if(!m)continue;
    const nums=m.mergeNums;
    assert.equal(nums.length,7,`${labels[i]} 必须输出 7 码`);
    assert.equal(new Set(nums).size,7,`${labels[i]} 号码不得重复`);
    const sum=nums.reduce((a,b)=>a+b,0);
    assert.ok(sum>=140&&sum<=210,`${labels[i]} 和值 ${sum} 超出 [140,210]`);
    const oddN=nums.filter(n=>n%2===1).length;
    assert.ok(oddN>=2&&oddN<=5,`${labels[i]} 单数 ${oddN} 超出 [2,5]`);
    const wv={red:0,blue:0,green:0};
    nums.forEach(n=>wv[waveType(n)]++);
    assert.ok(wv.red<=4&&wv.blue<=4&&wv.green<=4,`${labels[i]} 波色超限: ${JSON.stringify(wv)}`);
  }
});

test('组合约束：默认关闭，页面加载后 modelMode=orig',t=>{
  const page=loadPage({expose:expose()});
  assert.equal(page.sandbox.__X.modelMode,'orig');
  assert.equal(page.el('comboToggle').checked,false,'开关默认必须为关闭（HTML 中未打勾）');
});
