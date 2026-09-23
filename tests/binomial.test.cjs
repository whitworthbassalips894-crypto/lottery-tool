'use strict';
/**
 * 数值测试：精确二项右尾 P[Binomial(N,1/7) >= K]
 * - 参照值 tests/binomial-fixtures.json：Python Fraction 任意精度计算的精确有理数
 * - 实现不使用阶乘；每个 log-PMF 独立计算 + log 域累加（log-sum-exp, Kahan）
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {loadPage,hooks}=require('./helpers.cjs');

const page=loadPage();
const T=hooks(page);
const {binomRightTail,zContinuity,classifyExactP,fmtP}=T;

/** 精确有理数 "num/den" → 前 17 位有效十进制（足够 double 比较） */
function rationalToDouble(frac){
  const[ns,ds]=frac.split('/');
  const n=BigInt(ns),d=BigInt(ds);
  const digits=1300n;
  const scaled=n*(10n**digits)/d;
  const s=scaled.toString().padStart(1301,'0');
  const intpart=s.slice(0,s.length-1300);
  const str=(intpart==='0'?'0':intpart)+'.'+s.slice(s.length-1300);
  if(str.startsWith('0.')){
    let cnt=0,i=2;
    while(i<str.length&&cnt<17){if(str[i]!=='0')cnt++;i++;}
    return parseFloat(str.slice(0,i));
  }
  let cnt=0;const arr=[];
  for(const ch of str){
    if(ch==='.'){arr.push('.');continue;}
    if(ch!=='0')cnt++;
    arr.push(ch);
    if(cnt>=17)break;
  }
  return parseFloat(arr.join(''));
}

test('精确右尾：全部 274 个任意精度参照样本（相对误差 ≤ 5e-13）',()=>{
  const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'binomial-fixtures.json'),'utf8'));
  assert.ok(fixtures.fixtures.length>=200,'参照样本数量异常');
  let maxRel=0;
  for(const[N,K,frac]of fixtures.fixtures){
    const js=binomRightTail(N,K);
    const ref=rationalToDouble(frac);
    const rel=ref===0?(js===0?0:Infinity):Math.abs(js-ref)/ref;
    assert.ok(Number.isFinite(rel),`N=${N} K=${K} 结果非有限值: ${js}`);
    assert.ok(rel<=5e-13,`N=${N} K=${K} 相对误差 ${rel} 超过 5e-13（js=${js} ref=${ref}）`);
    if(rel>maxRel)maxRel=rel;
  }
  assert.ok(maxRel<1e-11,'整体精度异常');
});

test('固定核对点：N=58,K=13 的精确右尾 p 与约定值一致（1 ulp 内）',()=>{
  const p=binomRightTail(58,13);
  assert.ok(Math.abs(p-0.06298880271203224)<=1e-15,`p=${p}`);
  const cls=classifyExactP(p);
  assert.equal(cls.key,'marginal');
  assert.equal(cls.label,'边缘 / 不显著（可能为随机波动）');
});

test('固定核对点：N=58,K=14 应判为显著',()=>{
  const p=binomRightTail(58,14);
  assert.ok(Math.abs(p-0.03135150682202337)<=1e-14,`p=${p}`);
  assert.equal(classifyExactP(p).key,'sig');
});

test('显著性阈值：p<0.05 显著；0.05<=p<0.10 边缘；其余不显著',()=>{
  assert.equal(classifyExactP(0.0499).key,'sig');
  assert.equal(classifyExactP(0.05).key,'marginal'); // 仅严格小于 0.05 才显著
  assert.equal(classifyExactP(0.0999).key,'marginal');
  assert.equal(classifyExactP(0.1).key,'none');
  assert.equal(classifyExactP(0.5).key,'none');
  assert.equal(classifyExactP(NaN).key,'none');
});

test('边界：K<=0 → 1；K>N → 0；K=N；非法输入 → NaN',()=>{
  assert.equal(binomRightTail(58,0),1);
  assert.equal(binomRightTail(58,-3),1);
  assert.equal(binomRightTail(58,59),0);
  assert.equal(binomRightTail(1,2),0);
  assert.equal(binomRightTail(1,1),1/7);
  assert.ok(Math.abs(binomRightTail(1,1)-0.14285714285714285)<1e-15);
  assert.ok(Number.isNaN(binomRightTail(5.5,3)));
  assert.ok(Number.isNaN(binomRightTail(58,2.5)));
});

test('极端尾：可表示的次正规数不归零；超出表示范围归 0（UI 显示 <1e-300）',()=>{
  const p365=binomRightTail(365,365);
  assert.ok(p365>0&&p365<1e-300,`期望 (1/7)^365≈3.5e-309 可表示: ${p365}`);
  const p400=binomRightTail(400,400); // (1/7)^400 ≈ 1e-336 → 下溢
  assert.equal(p400,0);
  assert.equal(fmtP(0),'<1e-300');
  assert.ok(fmtP(p365).includes('e-309'),`期望科学计数法: ${fmtP(p365)}`);
});

test('K 远小于均值时右尾逼近 1 且不超过 1',()=>{
  const p=binomRightTail(1000,20);
  assert.ok(p<=1&&p>1-1e-9,`p=${p}`);
  const p143=binomRightTail(1000,143),p144=binomRightTail(1000,144);
  // 均值 N/7≈142.86：P(X>=143) 略大于 0.5 的镜像关系不要求精确，但必须单调且合理
  assert.ok(p143>0.45&&p143<0.56);
  assert.ok(p144<p143);
});

test('连续性修正 z 分数（仅参考）',()=>{
  const z=zContinuity(58,13);
  const expected=(13-58/7-0.5)/Math.sqrt(58*(1/7)*(6/7));
  assert.ok(Math.abs(z-expected)<1e-12,`z=${z} expected=${expected}`);
  assert.ok(z>1.5&&z<1.7);
  assert.equal(zContinuity(0,0),0); // N=0 → σ=0 → 0，避免 NaN
});
