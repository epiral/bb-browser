#!/usr/bin/env python3
"""
NDJSON 增量存储工具 — 去重写入，与数据来源无关

用法：
  python3 ndjson_store.py -d '<JSON字符串>' -o <输出文件>
  python3 ndjson_store.py -i <输入文件> -o <输出文件> [--extract <字段名>]
  <命令> | python3 ndjson_store.py -o <输出文件> [--extract <字段名>]
  python3 ndjson_store.py -o <输出文件> --stat

详细说明见 references/ndjson-store.md
"""

import argparse
import json
import sys
from pathlib import Path


def load_existing_ids(path: Path, key: str) -> set:
    """从 NDJSON 文件加载所有已存在的 key 值"""
    if not path.exists():
        return set()
    ids = set()
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                val = obj.get(key)
                if val is not None:
                    ids.add(val)
            except json.JSONDecodeError as e:
                print(f"[warn] 第 {lineno} 行 JSON 解析失败: {e}", file=sys.stderr)
    return ids


def append_record(path: Path, record: dict) -> None:
    """追加一条记录到 NDJSON 文件"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def parse_input(raw: str, extract: str | None) -> list[dict]:
    """
    解析输入 JSON，支持三种格式：
      - 单个对象 {}
      - 数组 [...]
      - 带 extract 字段的对象（如 thread_full 返回的 {"post": {...}, "comments": [...]}）
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"[error] 输入 JSON 解析失败: {e}", file=sys.stderr)
        sys.exit(1)

    # 优先按 --extract 提取子字段
    if extract:
        if isinstance(data, dict) and extract in data:
            data = data[extract]
        else:
            print(f"[warn] 输入中未找到字段 '{extract}'，将整体作为记录处理", file=sys.stderr)

    # 数组 → 展开为列表
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]

    # 单对象
    if isinstance(data, dict):
        return [data]

    print(f"[error] 不支持的输入类型: {type(data)}", file=sys.stderr)
    sys.exit(1)


def print_stat(path: Path, key: str) -> None:
    """打印文件统计信息"""
    if not path.exists():
        print(f"文件不存在: {path}")
        return
    ids = load_existing_ids(path, key)
    size_kb = path.stat().st_size / 1024
    print(f"文件：{path}")
    print(f"记录数：{len(ids)}")
    print(f"大小：{size_kb:.1f} KB")


def main():
    parser = argparse.ArgumentParser(
        description="NDJSON 增量存储工具 — 去重写入",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("-o", "--output", required=False,
                        help="目标 NDJSON 文件路径（如 /reddit-help/posts.ndjson）")
    parser.add_argument("-i", "--input", help="输入 JSON 文件路径（不指定则从 stdin 读取）")
    parser.add_argument("-d", "--data", help="直接传入 JSON 字符串（不需要文件或管道）")
    parser.add_argument("--key", default="id",
                        help="去重用的字段名（默认: id）")
    parser.add_argument("--extract", default=None,
                        help="从输入 JSON 中提取指定字段再处理（如 --extract post）")
    parser.add_argument("--stat", action="store_true",
                        help="只显示当前文件统计，不写入")
    args = parser.parse_args()

    if not args.output:
        parser.error("请指定 -o/--output 输出文件路径")

    out_path = Path(args.output)

    # 只查统计
    if args.stat:
        print_stat(out_path, args.key)
        return

    # 读取输入：优先级 --data > -i > stdin
    if args.data:
        raw = args.data
    elif args.input:
        raw = Path(args.input).read_text(encoding="utf-8")
    else:
        if sys.stdin.isatty():
            print("[error] 没有输入数据。请通过 -d、-i 或管道提供 JSON", file=sys.stderr)
            parser.print_help()
            sys.exit(1)
        raw = sys.stdin.read()

    if not raw.strip():
        print("[error] 输入为空", file=sys.stderr)
        sys.exit(1)

    # 解析记录
    records = parse_input(raw, args.extract)
    if not records:
        print("[warn] 输入中没有可处理的记录")
        return

    # 加载已有 ID
    existing_ids = load_existing_ids(out_path, args.key)
    before_count = len(existing_ids)

    # 去重写入
    saved, skipped = 0, 0
    for record in records:
        key_val = record.get(args.key)
        if key_val is None:
            print(f"[warn] 记录缺少字段 '{args.key}'，跳过: {str(record)[:80]}", file=sys.stderr)
            skipped += 1
            continue
        if key_val in existing_ids:
            skipped += 1
            continue
        append_record(out_path, record)
        existing_ids.add(key_val)
        saved += 1

    # 汇报结果
    print(f"输入 {len(records)} 条 → 新增 {saved} 条，跳过 {skipped} 条（含已有 {before_count} 条）")
    print(f"文件：{out_path}（共 {len(existing_ids)} 条）")


if __name__ == "__main__":
    main()
