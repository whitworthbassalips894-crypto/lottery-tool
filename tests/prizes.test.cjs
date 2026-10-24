'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers.cjs');

test('中国福彩快乐8现行设奖表（选一～选十）完整准确核算', () => {
  const { T } = loadPage();

  // 选十：中10浮动(500万封顶)、9=8000、8=720、7=80、6=5、5=3、0=2；1~4未中
  assert.equal(T.evalPrize(10, 10).amount, 5000000);
  assert.equal(T.evalPrize(10, 10).floating, true);
  assert.equal(T.evalPrize(10, 9).amount, 8000);
  assert.equal(T.evalPrize(10, 8).amount, 720);
  assert.equal(T.evalPrize(10, 7).amount, 80);
  assert.equal(T.evalPrize(10, 6).amount, 5);
  assert.equal(T.evalPrize(10, 5).amount, 3);
  assert.equal(T.evalPrize(10, 4).win, false);
  assert.equal(T.evalPrize(10, 1).win, false);
  assert.equal(T.evalPrize(10, 0).amount, 2);
  assert.equal(T.evalPrize(10, 0).zero, true);

  // 选九：中9浮动(25万封顶)、8=2000、7=225、6=22、5=5、4=3、0=2
  assert.equal(T.evalPrize(9, 9).amount, 250000);
  assert.equal(T.evalPrize(9, 9).floating, true);
  assert.equal(T.evalPrize(9, 8).amount, 2000);
  assert.equal(T.evalPrize(9, 7).amount, 225);
  assert.equal(T.evalPrize(9, 6).amount, 22);
  assert.equal(T.evalPrize(9, 5).amount, 5);
  assert.equal(T.evalPrize(9, 4).amount, 3);
  assert.equal(T.evalPrize(9, 3).win, false);
  assert.equal(T.evalPrize(9, 0).amount, 2);

  // 选八：8=50000、7=800、6=80、5=10、4=3、0=2
  assert.equal(T.evalPrize(8, 8).amount, 50000);
  assert.equal(T.evalPrize(8, 7).amount, 800);
  assert.equal(T.evalPrize(8, 6).amount, 80);
  assert.equal(T.evalPrize(8, 5).amount, 10);
  assert.equal(T.evalPrize(8, 4).amount, 3);
  assert.equal(T.evalPrize(8, 0).amount, 2);

  // 选七：7=8500、6=300、5=30、4=4、0=2
  assert.equal(T.evalPrize(7, 7).amount, 8500);
  assert.equal(T.evalPrize(7, 6).amount, 300);
  assert.equal(T.evalPrize(7, 5).amount, 30);
  assert.equal(T.evalPrize(7, 4).amount, 4);
  assert.equal(T.evalPrize(7, 3).win, false);
  assert.equal(T.evalPrize(7, 0).amount, 2);

  // 选六～选一：全不中不设奖
  assert.equal(T.evalPrize(6, 6).amount, 2880);
  assert.equal(T.evalPrize(6, 5).amount, 30);
  assert.equal(T.evalPrize(6, 4).amount, 10);
  assert.equal(T.evalPrize(6, 3).amount, 3);
  assert.equal(T.evalPrize(6, 0).win, false);

  assert.equal(T.evalPrize(5, 5).amount, 1000);
  assert.equal(T.evalPrize(5, 4).amount, 20);
  assert.equal(T.evalPrize(5, 3).amount, 3);
  assert.equal(T.evalPrize(5, 0).win, false);

  assert.equal(T.evalPrize(4, 4).amount, 93);
  assert.equal(T.evalPrize(4, 3).amount, 5);
  assert.equal(T.evalPrize(4, 2).amount, 3);
  assert.equal(T.evalPrize(4, 1).win, false);

  assert.equal(T.evalPrize(3, 3).amount, 52);
  assert.equal(T.evalPrize(3, 2).amount, 3);
  assert.equal(T.evalPrize(3, 1).win, false);

  assert.equal(T.evalPrize(2, 2).amount, 19);
  assert.equal(T.evalPrize(2, 1).win, false);

  assert.equal(T.evalPrize(1, 1).amount, 4.5);
  assert.equal(T.evalPrize(1, 0).win, false);
});
