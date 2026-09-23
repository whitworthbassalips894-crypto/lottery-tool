'use strict';
/**
 * 测试辅助：在 Node VM 中直接执行 index.html 内的原始页面代码（不另写一份算法实现）。
 * 提供最小 DOM / localStorage / 事件循环替身；不依赖任何 npm 包。
 *
 * 用法：
 *   const {loadPage, recordsUpTo, extraStorage} = require('./helpers.cjs');
 *   const page = loadPage();                       // 仅内置数据（截至 2026-200）
 *   const page2 = loadPage({preStorage: extraStorage('2026-258')}); // 内置 + 2026-201..258
 */
const fs=require('fs');
const path=require('path');
const vm=require('vm');

const PAGE_PATH=path.resolve(__dirname,'..','index.html');
const DATA_PATH=path.resolve(__dirname,'..','data','am-latest.json');
const STORAGE_KEY='lucky_draws_minimal_v1';
const BASE_LAST='2026-200'; // 页面内置数组 COMPRESSED_DATA 的最后一期（页面代码固定，不可修改）

function makeEl(){
  const el={
    style:{},dataset:{},value:'',textContent:'',innerHTML:'',children:[],
    type:'',className:'',hidden:false,disabled:false,checked:false,min:'0',max:'100',step:'1',
    _listeners:{},
    classList:{add(){},remove(){},toggle(){},contains(){return false}},
    addEventListener(ev,fn){(el._listeners[ev]=el._listeners[ev]||[]).push(fn);},
    removeEventListener(){},
    dispatch(ev,data){(el._listeners[ev]||[]).slice().forEach(fn=>fn(Object.assign({type:ev,target:el},data||{})));},
    appendChild(c){el.children.push(c);return c;},
    append(...a){el.children.push(...a);},
    replaceChildren(...a){el.children=a;},
    prepend(...a){el.children.unshift(...a);},
    focus(){},blur(){},select(){},click(){},remove(){},
    querySelector(){return null;},
    querySelectorAll(){return[];},
    getAttribute(){return null;},
    setAttribute(){},
    insertAdjacentHTML(){},
    getBoundingClientRect(){return{top:0,left:0,width:100,height:20};},
    files:null,parentNode:null,firstChild:null,lastChild:null,nextSibling:null,
  };
  return el;
}

function makeDocument(){
  const els=new Map();
  return{
    getElementById(id){if(!els.has(id))els.set(id,makeEl());return els.get(id);},
    createElement(){return makeEl();},
    createTextNode(t){return{textContent:t};},
    querySelectorAll(){return[];},
    querySelector(){return null;},
    body:makeEl(),
    addEventListener(){},removeEventListener(){},
    title:'',
  };
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function waitFor(pred,timeout=15000,stepMs=15){
  const t0=Date.now();
  for(;;){
    if(pred())return true;
    if(Date.now()-t0>timeout)throw new Error('waitFor 超时');
    await sleep(stepMs);
  }
}

/** 读取仓库开奖数据（不要修改该文件）；按期号升序、label <= maxLabel */
function recordsUpTo(maxLabel){
  const j=JSON.parse(fs.readFileSync(DATA_PATH,'utf8'));
  if(!Array.isArray(j.records))throw new Error('data/am-latest.json 缺少 records');
  return j.records
    .filter(r=>r&&r.label&&r.label<=maxLabel)
    .map(r=>({label:r.label,nums:r.nums.map(Number),special:Number(r.nums[6])}))
    .sort((a,b)=>a.label<b.label?-1:1);
}

/** 构造"一键同步/粘贴导入"写入 localStorage 的内容：只含内置数据之后的连续期号 */
function extraStorage(maxLabel){
  const recs=recordsUpTo(maxLabel).filter(r=>r.label>BASE_LAST);
  return{
    [STORAGE_KEY]:JSON.stringify({
      version:1,
      draws:recs.map(r=>r.nums.slice()),
      labels:recs.map(r=>r.label),
      savedAt:new Date().toISOString(),
    }),
  };
}

/**
 * 在 VM 中执行页面全部 <script> 代码。
 * opts.preStorage: {storageKey: rawString} 在页面脚本运行前写入 localStorage（模拟已同步数据）。
 */
function loadPage(opts={}){
  const html=fs.readFileSync(PAGE_PATH,'utf8');
  const re=/<script>([\s\S]*?)<\/script>/g;
  let m;const blocks=[];
  while((m=re.exec(html)))blocks.push(m[1]);
  if(!blocks.length)throw new Error('index.html 中没有内联 <script>');
  const doc=makeDocument();
  const store=new Map();
  for(const[k,v]of Object.entries(opts.preStorage||{}))store.set(k,String(v));
  const localStorage={
    getItem:k=>store.has(k)?store.get(k):null,
    setItem:(k,v)=>store.set(k,String(v)),
    removeItem:k=>store.delete(k),
    clear(){store.clear();},
  };
  const listeners={};
  const cryptoObj={getRandomValues:(arr)=>{globalThis.crypto.getRandomValues(arr);return arr;}};
  const window={
    addEventListener:(ev,fn)=>{(listeners[ev]=listeners[ev]||[]).push(fn);},
    removeEventListener(){},
    location:{href:'http://localhost/'},
    crypto:cryptoObj,
  };
  window.window=window;
  const sandbox={
    window,document:doc,localStorage,
    console,
    setTimeout:(fn,ms)=>setTimeout(fn,ms==null?0:ms),
    clearTimeout:(t)=>clearTimeout(t),
    setInterval:(fn,ms)=>setInterval(fn,ms||1000),
    clearInterval:(t)=>clearInterval(t),
    requestAnimationFrame:(fn)=>setTimeout(()=>fn(Date.now()),0),
    alert(){},confirm(){return false;},prompt(){return null;},
    fetch:async()=>{throw new Error('offline (test)');},
    FileReader:class{readAsText(){}},
    Blob:class{constructor(){}},
    URL:{createObjectURL:()=>'',revokeObjectURL(){}},
    navigator:{clipboard:{writeText:async()=>{}}},
    history:{back(){}},
    crypto:cryptoObj, // 与 window.crypto 同一对象（浏览器中二者同源）
    JSON,Math,Date,Array,Object,Set,Map,Promise,Number,String,RegExp,Error,TypeError,RangeError,Symbol,Proxy,Reflect,Intl,BigInt,
    performance:{now:()=>Date.now()},
  };
  sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  for(const code of blocks){
    vm.runInContext(code,sandbox,{filename:PAGE_PATH});
  }
  if(opts.expose)vm.runInContext(opts.expose,sandbox,{filename:PAGE_PATH+'#expose'});
  return{
    sandbox,doc,localStorage,
    el:id=>doc.getElementById(id),
    fireLoad:()=>(listeners['load']||[]).slice().forEach(fn=>fn()),
    sleep,waitFor,
  };
}

/** 页面测试钩子（index.html 内 window.__LOTTO_SYNC_TEST__） */
function hooks(page){
  const T=page.sandbox.window.__LOTTO_SYNC_TEST__;
  if(!T)throw new Error('页面测试钩子 __LOTTO_SYNC_TEST__ 缺失');
  return T;
}

/** 等待前瞻计算完成：fwdBody 出现数据行或错误行 */
async function waitForForward(page){
  const el=page.el('fwdBody');
  await page.waitFor(()=>/计算中|<tr class=|colspan/.test(el.innerHTML));
  await page.waitFor(()=>!el.innerHTML.includes('计算中'));
}

module.exports={loadPage,recordsUpTo,extraStorage,hooks,waitForForward,sleep,waitFor,PAGE_PATH,DATA_PATH,STORAGE_KEY,BASE_LAST};
