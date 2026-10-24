'use strict';
/**
 * 测试辅助：在 Node VM 中直接执行 index.html 内的原始页面代码，不另写算法副本。
 * 零第三方依赖。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE_PATH = path.resolve(__dirname, '..', 'index.html');
const DATA_PATH = path.resolve(__dirname, '..', 'data', 'kl8-latest.json');
const STORAGE_KEY = 'kl8_manual_draws_v1';

function makeEl(id = '') {
  const el = {
    id,
    style: {},
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    children: [],
    type: '',
    className: '',
    hidden: false,
    disabled: false,
    checked: false,
    _listeners: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    },
    addEventListener(ev, fn) {
      (el._listeners[ev] = el._listeners[ev] || []).push(fn);
    },
    removeEventListener() {},
    dispatch(ev, data) {
      (el._listeners[ev] || []).slice().forEach(fn =>
        fn(Object.assign({ type: ev, target: el, currentTarget: el }, data || {}))
      );
    },
    appendChild(c) { el.children.push(c); return c; },
    append(...a) { el.children.push(...a); },
    replaceChildren(...a) { el.children = a; },
    focus() {},
    blur() {},
    select() {},
    click() { el.dispatch('click'); },
    remove() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
    files: null
  };
  return el;
}

function makeDocument() {
  const els = new Map();
  return {
    _els: els,
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    createElement(tag) { return makeEl(tag); },
    createTextNode(t) { return { textContent: t }; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    execCommand() { return true; },
    body: makeEl('body'),
    addEventListener() {},
    removeEventListener() {},
    title: ''
  };
}

function loadPage(opts = {}) {
  const html = fs.readFileSync(PAGE_PATH, 'utf8');
  const re = /<script>([\s\S]*?)<\/script>/g;
  const blocks = [];
  let m;
  while ((m = re.exec(html))) blocks.push(m[1]);
  if (!blocks.length) throw new Error('index.html 中未找到 <script> 块');

  const store = new Map(Object.entries(opts.preStorage || {}));
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    _dump() { return Object.fromEntries(store.entries()); }
  };

  const alerts = [];
  const confirms = [];
  const document = makeDocument();
  const winListeners = {};

  const defaultFetch = async (url) => {
    if (String(url).includes('kl8-latest.json')) {
      const body = fs.readFileSync(DATA_PATH, 'utf8');
      return {
        ok: true,
        status: 200,
        async json() { return JSON.parse(body); },
        async text() { return body; }
      };
    }
    return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; } };
  };

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    Error,
    TypeError,
    Int16Array,
    Int32Array,
    Uint8Array,
    Uint32Array,
    Float64Array,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    Infinity,
    NaN,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    localStorage,
    document,
    navigator: { clipboard: null },
    location: { protocol: 'https:' },
    URL: { createObjectURL() { return 'blob:mock'; }, revokeObjectURL() {} },
    Blob: class MockBlob { constructor(parts) { this.parts = parts; } },
    FileReader: class MockFileReader {},
    fetch: opts.fetch || defaultFetch,
    alert(msg) { alerts.push(String(msg)); },
    confirm(msg) {
      confirms.push(String(msg));
      return opts.confirmResult !== undefined ? opts.confirmResult : true;
    },
    addEventListener(ev, fn) {
      (winListeners[ev] = winListeners[ev] || []).push(fn);
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  for (let i = 0; i < blocks.length; i++) {
    vm.runInContext(blocks[i], sandbox, { filename: `index.html#script${i + 1}` });
  }
  if (opts.expose) {
    vm.runInContext(opts.expose, sandbox, { filename: 'expose.js' });
  }

  return {
    html,
    sandbox,
    document,
    localStorage,
    alerts,
    confirms,
    T: sandbox.window.__KL8_TEST__
  };
}

module.exports = { PAGE_PATH, DATA_PATH, STORAGE_KEY, loadPage };
