# 彩系工具部署说明

## 最简单部署到 GitHub Pages
1. 打开你的 GitHub 仓库。
2. 上传或替换 `index.html`。
3. 如果仓库已有 `manifest.json`、`sw.js`，可以保留；本工具单文件也能直接运行。
4. 到 Settings → Pages，确认 Source 选择 main 分支 / root。
5. 等待 GitHub Pages 自动部署。

## 日常使用
- 不需要每天重新抓历史数据。
- 每天打开网页，在顶部录入最新开奖号码并保存即可。
- 手动录入的数据保存在当前浏览器 localStorage。

## 什么时候需要运行抓取脚本？
只有当你想把网站最新开奖记录固化进 `index.html` 底层数据时才需要运行。
如果网站拦截 Python 请求，可用浏览器保存页面 HTML 后使用脚本的 `--input-dir` 模式。

## 注意
如果换电脑/换浏览器，localStorage 不会自动同步。建议使用工具内“导出备份”。
