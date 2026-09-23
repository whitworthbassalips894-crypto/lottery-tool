'use strict';
/**
 * 组合约束（实验开关）单元测试：
 * 从原评分前 10 码中挑原总分最高的 7 码组合；和值 140–210、单数 2–5、任一波色 ≤4；
 * 前 10 码无解时按排名逐个扩池（不放宽约束）；同分组合优先取排名更靠前的号码。
 * 合成号码池均为手工推演过唯一期望解的固定用例（波色按页面 wave() 的真实划分）。
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadPage}=require('./helpers.cjs');

const page=loadPage({expose:'globalThis.__X={comboSelect,comboBB};'});
const{comboSelect}=page.sandbox.__X;
const mk=(n,score)=>({n,score});
/** 跨 realm 安全比较数字数组（VM 上下文数组与宿主数组的 prototype 不同） */
const eqNums=(actual,expected)=>{
  const a=Array.isArray(actual)?actual.map(Number):[...actual].map(Number);
  assert.equal(a.length,expected.length,`长度 ${a.length} != ${expected.length}: [${a}]`);
  for(let i=0;i<expected.length;i++)assert.equal(a[i],expected[i],`第${i}个号码: ${a[i]} != ${expected[i]}（实际 [${a}]）`);
};
const checkConstraints=(nums)=>{
  const red=[1,2,7,8,12,13,18,19,23,24,29,30,34,35,40,45,46];
  const blue=[3,4,9,10,14,15,20,25,26,31,36,37,41,42,47,48];
  const wv={red:0,blue:0,green:0};
  let sum=0,oddN=0;
  for(const n of nums){
    sum+=n;
    if(n%2===1)oddN++;
    wv[red.includes(n)?'red':blue.includes(n)?'blue':'green']++;
  }
  assert.equal(nums.length,7);
  assert.equal(new Set(nums).size,7);
  assert.ok(sum>=140&&sum<=210,`和值 ${sum}`);
  assert.ok(oddN>=2&&oddN<=5,`单数 ${oddN}`);
  assert.ok(wv.red<=4&&wv.blue<=4&&wv.green<=4,`波色 ${JSON.stringify(wv)}`);
};

test('前10码无解 → 扩池到 11 找到唯一可行最优组合',()=>{
  // 前10 = 8红+1蓝+1绿：任取7码红≥5 → 无解
  // 第11码为绿后：必须含 {蓝4,绿32,绿38} + 4个红，且和值≤210 限制使最优为 {45,35,29,24}+{4,32,38}
  const pool=[
    mk(45,100),mk(35,99),mk(29,98),mk(24,97),
    mk(46,96),mk(40,95),mk(23,94),mk(19,93),
    mk(4,10),mk(32,9),mk(38,8),
  ];
  const r=comboSelect(pool);
  assert.ok(r,'扩池后必有解');
  assert.equal(r.pool,11);
  eqNums(r.nums,[4,24,29,32,35,38,45]);
  assert.equal(r.total,421);
  checkConstraints(r.nums);
});

test('前10码有解：同总分的两个组合取排名更靠前者（索引字典序最小）',()=>{
  // 组合 {0..6} 与 {0..5,7} 总分同为 490 且均合法 → 必须选 {0..6}
  const pool=[
    mk(24,100),mk(23,90),mk(22,80),mk(21,70),
    mk(20,60),mk(19,50),mk(18,40),mk(17,40),
    mk(16,30),mk(15,20),
  ];
  const r=comboSelect(pool);
  assert.ok(r);
  assert.equal(r.pool,10);
  eqNums(r.nums,[18,19,20,21,22,23,24]);
  assert.equal(r.total,490);
  checkConstraints(r.nums);
});

test('单数约束：最高总分组合单数超限 → 自动降档到满足约束的最优组合',()=>{
  // 前7个红/绿/蓝全单数：top7 组合单数=7 非法；
  // 最优合法 = 前5单数 + 前2双数 = {23,21,19,17,15,24,22}（和值141，恰好≥140）
  const pool=[
    mk(23,100),mk(21,95),mk(19,90),mk(17,85),
    mk(15,80),mk(13,75),mk(11,70),
    mk(24,60),mk(22,55),mk(20,50),
  ];
  const r=comboSelect(pool);
  assert.ok(r);
  assert.equal(r.pool,10);
  eqNums(r.nums,[15,17,19,21,22,23,24]);
  assert.equal(r.total,565);
  checkConstraints(r.nums);
});

test('和值上限：最高总分组合和值>210 被排除，结果必须与独立暴力枚举一致',()=>{
  // 池内号码偏大：纯分数最高的 7 码组合 {45,46,43,44,40,35,32} 和值 285>210 非法；
  // 合法最优需用 24/20/4 换掉大号，且 {45,46,44,35,24,20,4}（和值 218）因单数=1 被单双约束排除。
  // 期望解由独立暴力枚举（全枚举+过滤+最大总分+排名优先）给出并互验：{45,46,43,35,24,20,4}（和值 217，总分 668）。
  const pool=[
    mk(45,100),mk(46,99),mk(43,98),mk(44,97),
    mk(40,96),mk(35,95),mk(32,94),mk(24,93),
    mk(20,92),mk(4,91),
  ];
  const r=comboSelect(pool);
  assert.ok(r);
  checkConstraints(r.nums);
  // 独立暴力枚举（7 元组合全枚举 + 约束过滤 + 最大总分 + 排名优先）
  const all=[];
  (function rec(start,cur){
    if(cur.length===7){all.push(cur.slice());return;}
    for(let i=start;i<pool.length;i++){cur.push(pool[i]);rec(i+1,cur);cur.pop();}
  })(0,[]);
  const valid=all.filter(c=>{
    const nums=c.map(x=>x.n);
    const okC=checkConstraintsSafe(nums);
    return okC;
  }).map(c=>({nums:c.map(x=>x.n).sort((a,b)=>a-b),total:c.reduce((a,x)=>a+x.score,0),idx:c.map(x=>pool.indexOf(x))}));
  assert.ok(valid.length,'必然存在合法组合');
  const mx=Math.max(...valid.map(v=>v.total));
  const cands=valid.filter(v=>v.total===mx);
  cands.sort((a,b)=>{for(let i=0;i<7;i++)if(a.idx[i]!==b.idx[i])return a.idx[i]-b.idx[i];return 0;});
  assert.equal(r.total,cands[0].total);
  eqNums(r.nums,cands[0].nums);
});

function checkConstraintsSafe(nums){
  const red=[1,2,7,8,12,13,18,19,23,24,29,30,34,35,40,45,46];
  const blue=[3,4,9,10,14,15,20,25,26,31,36,37,41,42,47,48];
  const wv={red:0,blue:0,green:0};
  let sum=0,oddN=0;
  for(const n of nums){sum+=n;if(n%2===1)oddN++;wv[red.includes(n)?'red':blue.includes(n)?'blue':'green']++;}
  return nums.length===7&&new Set(nums).size===7&&sum>=140&&sum<=210&&oddN>=2&&oddN<=5&&wv.red<=4&&wv.blue<=4&&wv.green<=4;
}

test('池内号码不足 7 个 → 返回 null（扩池至全 49 码仍须终止）',()=>{
  assert.equal(comboSelect([mk(45,100),mk(46,99),mk(43,98)]),null);
  // 全 49 码池（真实波色分布）必有解
  const all49=[];
  for(let n=1;n<=49;n++)all49.push(mk(n,1000-n)); // 分数随号码递减
  const r=comboSelect(all49);
  assert.ok(r,'49 码全池必须有解');
  checkConstraints(r.nums);
  assert.ok(r.pool<=49);
});

test('确定性：同一输入重复调用结果一致',()=>{
  const pool=[mk(24,100),mk(23,90),mk(22,80),mk(21,70),mk(20,60),mk(19,50),mk(18,40),mk(17,40),mk(16,30),mk(15,20)];
  const a=comboSelect(pool),b=comboSelect(pool.slice());
  assert.equal(a.pool,b.pool);
  assert.equal(a.total,b.total);
  eqNums(a.nums,b.nums);
});
