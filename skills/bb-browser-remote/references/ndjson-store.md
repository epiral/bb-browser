# ndjson_store.py — 增量 NDJSON 存储工具

将任意 JSON 数据去重后增量写入 NDJSON 文件（每行一个 JSON 对象）。与数据来源无关，可配合任何输出 JSON 的命令使用。

> **使用原则**：调用本工具前，应优先选择能获取完整信息的方式获取数据，而非保存列表摘要或截断内容。存入的数据质量决定后续分析的上限。

脚本路径：`~/.openclaw/skills/bb-browser-remote/scripts/ndjson_store.py`

---

## 参数

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `-o` / `--output` | ✅ | 目标 NDJSON 文件路径 |
| `-d` / `--data` | | 直接传入 JSON 字符串（优先级最高） |
| `-i` / `--input` | | 输入 JSON 文件路径 |
| `--key` | | 去重字段名，默认 `id` |
| `--extract` | | 从输入 JSON 中提取指定字段再处理 |
| `--stat` | | 只显示文件统计，不写入 |

输入优先级：`-d` > `-i` > stdin

---

## 支持的输入格式

| 输入内容 | 处理方式 |
|---------|---------|
| 单个对象 `{}` | 直接作为一条记录 |
| 数组 `[{}, {}]` | 展开为多条，逐一去重写入 |
| 嵌套对象 `{"post": {...}}` | `--extract post` 提取后写入 |
| 嵌套数组 `{"items": [{}, {}]}` | `--extract items` 提取数组后展开写入 |

---

## 示例

```bash
# 直接传 JSON 字符串（最简洁，无需文件或管道）
python3 ndjson_store.py -d '{"id":"abc","title":"hello"}' -o /data/output.ndjson

# 直接传 JSON 字符串 + 提取子字段
python3 ndjson_store.py \
  -d '{"post":{"id":"x","body":"..."}}' \
  -o /data/output.ndjson --extract post

# 从管道写入
echo '[{"id":"a"},{"id":"b"}]' \
  | python3 ndjson_store.py -o /data/output.ndjson

# 从文件读取
python3 ndjson_store.py -i result.json -o /data/output.ndjson

# 自定义去重字段（默认是 id）
python3 ndjson_store.py -d '{"url":"https://..."}' -o /data/output.ndjson --key url

# 查看统计
python3 ndjson_store.py -o /data/output.ndjson --stat
```

在 Python 代码中直接传字符串：

```python
import subprocess, json

data = {"id": "t3_1sg2v7n", "title": "...", "selftext": "..."}

subprocess.run(
    ["python3", "ndjson_store.py", "-d", json.dumps(data), "-o", "/reddit-help/posts.ndjson"],
    text=True
)
```

---

## 输出示例

```
# 第一次写入
输入 3 条 → 新增 3 条，跳过 0 条（含已有 0 条）
文件：/data/output.ndjson（共 3 条）

# 第二次写入（其中 2 条已有，1 条新增）
输入 3 条 → 新增 1 条，跳过 2 条（含已有 3 条）
文件：/data/output.ndjson（共 4 条）
```

---

## 增量机制

每次启动时一次性读取目标文件中所有记录的 `--key` 字段值加载到内存 set，写入时先查 set 判断是否重复，新记录追加到文件末尾并同步更新 set。文件不存在时自动创建（含父目录）。
