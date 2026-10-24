#!/usr/bin/env node
'use strict';
/**
 * GitHub Actions 工作流兼容入口（桥接 sync-kl8.js）
 *
 * 说明：仓库既有 .github/workflows/sync-lottery.yml 调用 `node scripts/sync-am.js`
 * 并提交暂存区改动。此入口直接委托 sync-kl8.js 抓取福彩快乐8数据更新 data/kl8-latest.json，
 * 同时同步轻量状态文件 data/am-latest.json 并将 data/kl8-latest.json 加入 git 暂存区，
 * 确保无需改动 workflow 文件即可每日自动同步并推送快乐8最新开奖记录。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const kl8 = require('./sync-kl8.js');

const ROOT = path.resolve(__dirname, '..');
const COMPAT_FILE = path.join(ROOT, 'data', 'am-latest.json');

kl8.main().then(res => {
  if (!res || !res.changed || !res.outObj) return;
  const meta = {
    note: 'KL8 sync workflow status pointer (actual dataset in data/kl8-latest.json)',
    updatedAt: res.outObj.updatedAt,
    latestCode: res.outObj.latestCode,
    latestDate: res.outObj.latestDate,
    latestLabel: res.outObj.latestLabel || `KL8-${res.outObj.latestCode}`
  };
  fs.writeFileSync(COMPAT_FILE, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  if (process.env.GITHUB_ACTIONS) {
    try {
      execFileSync('git', ['add', 'data/kl8-latest.json'], { cwd: ROOT, stdio: 'inherit' });
    } catch (e) {
      console.warn('[warn] git add data/kl8-latest.json 失败：', e && e.message || e);
    }
  }
}).catch(e => {
  console.error(`::error::${e && e.message || e}`);
  process.exit(1);
});
