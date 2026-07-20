#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓取开奖记录并生成新版工具 HTML

默认抓取澳门记录：
  2026: https://2026kj.zkclhb.com:2025/am.html
  2025: https://2026kj.zkclhb.com:2025/2025.html
  ...

用法：
  python 抓取历史数据并生成工具.py \
    --base-html 六叔公判断工具_最终版_生肖按年修正.html \
    --out 六叔公判断工具_自动更新底库版.html \
    --years 2020-2026

如果网站拦截脚本请求，可先用浏览器把每年网页另存为 html 到一个文件夹，然后：
  python 抓取历史数据并生成工具.py --input-dir ./pages --years 2020-2026
文件名可为：am.html、2025.html、2024.html ... 或 2026.html。
"""

from __future__ import annotations

import argparse
import html as html_lib
import json
import re
import ssl
import sys
import time
import urllib.request
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

ZODIACS = "鼠牛虎兔龙蛇马羊猴鸡狗猪"
DEFAULT_BASE_URL = "https://2026kj.zkclhb.com:2025"


def year_url(year: int, mode: str = "am", base_url: str = DEFAULT_BASE_URL) -> str:
    base_url = base_url.rstrip("/")
    if int(year) == 2026:
        return f"{base_url}/{mode}.html"
    return f"{base_url}/{year}.html"


def normalize_years(s: str) -> List[int]:
    s = str(s).strip()
    if "-" in s:
        a, b = s.split("-", 1)
        return list(range(int(a), int(b) + 1))
    return [int(x) for x in re.split(r"[,，\s]+", s) if x]


def fetch_url(url: str, timeout: int = 20, sleep: float = 0.5) -> str:
    """下载网页。部分服务器可能会 403；此时建议使用 --input-dir。"""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Connection": "keep-alive",
        "Referer": url,
    }
    req = urllib.request.Request(url, headers=headers)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
    time.sleep(sleep)
    for enc in ("utf-8", "gb18030", "big5", "latin1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="ignore")


def load_page_for_year(year: int, args: argparse.Namespace) -> str:
    if args.input_dir:
        d = Path(args.input_dir)
        candidates = []
        if year == 2026:
            candidates += [d / f"{args.mode}.html", d / "2026.html", d / "am.html"]
        candidates += [d / f"{year}.html", d / f"{year}.htm", d / f"{year}.txt", d / f"{year}.md"]
        for f in candidates:
            if f.exists():
                return f.read_text(encoding="utf-8", errors="ignore")
        raise FileNotFoundError(f"找不到 {year} 年页面文件，尝试过：" + ", ".join(map(str, candidates)))
    url = year_url(year, args.mode, args.base_url)
    return fetch_url(url, timeout=args.timeout, sleep=args.sleep)


def html_to_text(page: str) -> str:
    # 删除 script/style；保留换行，便于正则按文本扫描。
    page = re.sub(r"<script\b[\s\S]*?</script>", "\n", page, flags=re.I)
    page = re.sub(r"<style\b[\s\S]*?</style>", "\n", page, flags=re.I)
    page = re.sub(r"<br\s*/?>", "\n", page, flags=re.I)
    page = re.sub(r"</(?:div|p|li|tr|td|th|span|h\d)>", "\n", page, flags=re.I)
    page = re.sub(r"<[^>]+>", " ", page)
    page = html_lib.unescape(page)
    # markdown 星号也去掉，fetch/另存文本都能解析
    page = page.replace("**", " ")
    page = re.sub(r"[\t\r]+", " ", page)
    page = re.sub(r"\n\s+", "\n", page)
    page = re.sub(r"\s+", " ", page)
    return page


def parse_draws(page: str, year: int) -> List[List[int]]:
    """解析单页，返回 [[year, period, n1..n7], ...]。"""
    text = html_to_text(page)
    # 找每个“201 期”区块，再在相邻区块内找前7个号码。
    period_pat = re.compile(r"(?<!\d)(\d{1,3})\s*期(?:\s*\([^)]*?\))?", re.I)
    matches = list(period_pat.finditer(text))
    rows: Dict[int, List[int]] = {}
    for idx, m in enumerate(matches):
        period = int(m.group(1))
        start = m.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else min(len(text), start + 800)
        block = text[start:end]
        # 只取带生肖或纯数字附近的号码；开奖记录每期区块的前7个两位/一位数字就是号码。
        nums = []
        for nm in re.finditer(r"(?<!\d)(\d{1,2})(?!\d)\s*(?:[" + ZODIACS + r"])?", block):
            n = int(nm.group(1))
            if 1 <= n <= 49:
                nums.append(n)
            if len(nums) >= 7:
                break
        if len(nums) == 7:
            rows[period] = [int(year), period] + nums
    if not rows:
        raise ValueError(f"{year} 年页面未解析到开奖记录。可能网站结构变化或页面被拦截。")
    return [rows[p] for p in sorted(rows)]


def replace_compressed_data(base_html: str, data_rows: List[List[int]]) -> str:
    data_rows = sorted(data_rows, key=lambda r: (r[0], r[1]))
    chunks = []
    for i in range(0, len(data_rows), 6):
        chunks.append("    " + ",".join("[" + ",".join(map(str, r)) + "]" for r in data_rows[i:i+6]))
    new_block = "const COMPRESSED_DATA = [\n" + ",\n".join(chunks) + "\n];"
    pattern = re.compile(r"const\s+COMPRESSED_DATA\s*=\s*\[[\s\S]*?\];", re.M)
    if not pattern.search(base_html):
        raise ValueError("base-html 中找不到 const COMPRESSED_DATA = [...] 区块。")
    return pattern.sub(new_block, base_html, count=1)


def summarize(rows: List[List[int]]) -> str:
    by_year: Dict[int, List[int]] = {}
    for r in rows:
        by_year.setdefault(r[0], []).append(r[1])
    parts = []
    for y in sorted(by_year):
        ps = sorted(by_year[y])
        parts.append(f"{y}: {len(ps)}期 ({ps[0]:03d}-{ps[-1]:03d})")
    return "；".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser(description="抓取开奖记录并生成新版工具 HTML")
    ap.add_argument("--base-html", default="/home/user/六叔公判断工具_最终版_生肖按年修正.html", help="作为模板的工具HTML")
    ap.add_argument("--out", default="/home/user/六叔公判断工具_自动更新底库版.html", help="输出HTML路径")
    ap.add_argument("--years", default="2020-2026", help="年份，如 2020-2026 或 2024,2025,2026")
    ap.add_argument("--mode", default="am", choices=["am", "hk"], help="am=澳门记录；hk=香港记录")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL, help="网站根地址")
    ap.add_argument("--input-dir", default="", help="如果在线抓取被403，可指定已保存网页文件夹")
    ap.add_argument("--timeout", type=int, default=20)
    ap.add_argument("--sleep", type=float, default=0.5)
    ap.add_argument("--dump-json", default="", help="可选：把解析后的数据另存为JSON")
    args = ap.parse_args()

    years = normalize_years(args.years)
    all_rows: List[List[int]] = []
    for y in years:
        try:
            page = load_page_for_year(y, args)
            rows = parse_draws(page, y)
            print(f"[OK] {y}: {len(rows)}期，范围 {rows[0][1]:03d}-{rows[-1][1]:03d}")
            all_rows.extend(rows)
        except Exception as e:
            print(f"[失败] {y}: {e}", file=sys.stderr)
            if not args.input_dir:
                print("       若遇到403，请用浏览器把页面另存为HTML后使用 --input-dir。", file=sys.stderr)
            raise

    # 去重：同年同期保留最后解析到的一条
    dedup: Dict[Tuple[int, int], List[int]] = {}
    for r in all_rows:
        dedup[(r[0], r[1])] = r
    all_rows = sorted(dedup.values(), key=lambda r: (r[0], r[1]))

    base_path = Path(args.base_html)
    if not base_path.exists():
        raise FileNotFoundError(f"模板HTML不存在：{base_path}")
    base_html = base_path.read_text(encoding="utf-8", errors="ignore")
    out_html = replace_compressed_data(base_html, all_rows)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(out_html, encoding="utf-8")

    if args.dump_json:
        Path(args.dump_json).write_text(json.dumps(all_rows, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n生成完成：", out_path)
    print("数据汇总：", summarize(all_rows))


if __name__ == "__main__":
    main()
