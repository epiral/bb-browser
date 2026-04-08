# 各平台操作速查

通过 `site_run` 调用，完整格式：

```bash
python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py \
  --tool site_run --args '{"name":"平台/命令","args":["参数1","参数2"]}'
```

> 不确定某平台支持哪些命令或参数格式，先用 `site_info` 查询：
> ```bash
> python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py \
>   --tool site_info --args '{"name":"twitter/search"}'
> ```

---

## 🐦 Twitter/X

```bash
--tool site_run --args '{"name":"twitter/for_you"}'
--tool site_run --args '{"name":"twitter/following"}'
--tool site_run --args '{"name":"twitter/search","args":["关键词"]}'
--tool site_run --args '{"name":"twitter/post","args":["推文内容"]}'
--tool site_run --args '{"name":"twitter/tweets","args":["用户名"]}'
--tool site_run --args '{"name":"twitter/notifications"}'
--tool site_run --args '{"name":"twitter/bookmarks"}'
```

## 🌸 小红书

```bash
--tool site_run --args '{"name":"xiaohongshu/feed"}'
--tool site_run --args '{"name":"xiaohongshu/search","args":["关键词"]}'
--tool site_run --args '{"name":"xiaohongshu/note","args":["笔记ID"]}'
--tool site_run --args '{"name":"xiaohongshu/comments","args":["笔记ID"]}'
--tool site_run --args '{"name":"xiaohongshu/me"}'
```

## 📌 Pinterest

```bash
--tool site_run --args '{"name":"pinterest/boards"}'

# 发 Pin（先打开创建页确保登录态）
--tool browser_open --args '{"url":"https://www.pinterest.com/pin-creation-tool/"}'
--tool site_run --args '{"name":"pinterest/post","args":["图片URL","Board名称","标题","描述","跳转链接"]}'
```

## 🎬 YouTube

```bash
--tool site_run --args '{"name":"youtube/feed"}'
--tool site_run --args '{"name":"youtube/search","args":["关键词"]}'
--tool site_run --args '{"name":"youtube/video","args":["视频ID"]}'
--tool site_run --args '{"name":"youtube/post","args":["内容"]}'
```

## 🌐 微博

```bash
--tool site_run --args '{"name":"m_weibo/hot"}'
--tool site_run --args '{"name":"m_weibo/post","args":["内容"]}'
--tool site_run --args '{"name":"m_weibo/search","args":["关键词"]}'
--tool site_run --args '{"name":"m_weibo/me"}'
```

## 👾 Reddit

```bash
# 热帖
--tool site_run --args '{"name":"reddit/hot","args":[]}'
--tool site_run --args '{"name":"reddit/hot","args":["LocalLLaMA"]}'

# 搜索（关键词、subreddit、排序、时间范围、数量）
--tool site_run --args '{"name":"reddit/search","args":["关键词","LocalLLaMA","top","month","20"]}'

# 帖子评论树（基础版）
--tool site_run --args '{"name":"reddit/thread","args":["https://www.reddit.com/r/LocalLLaMA/comments/xxx/"]}'

# 帖子完整内容（增强版）— 支持相册图片、视频、转帖展开
# 返回：post.selftext（完整正文）、post.images（图片列表含URL+尺寸）、post.video（视频URL）、post.crosspost_from（转帖原文）、comments（含创建时间）
--tool site_run --args '{"name":"reddit/thread_full","args":["https://www.reddit.com/r/rednote/comments/xxx/"]}'

# 用户信息
--tool site_run --args '{"name":"reddit/me","args":[]}'

# 查询 flair（发帖前先查）
--tool site_run --args '{"name":"reddit/flairs","args":["LocalLLaMA"]}'

# 发文字帖
--tool site_run --args '{"name":"reddit/post_text","args":["subreddit","标题","正文内容"]}'
--tool site_run --args '{"name":"reddit/post_text","args":["subreddit","标题","正文"],"namedArgs":{"flair_id":"abc123"}}'
--tool site_run --args '{"name":"reddit/post_text","args":["subreddit","标题","正文"],"namedArgs":{"nsfw":"true"}}'

# 发链接帖
--tool site_run --args '{"name":"reddit/post_link","args":["subreddit","标题","https://example.com"]}'
--tool site_run --args '{"name":"reddit/post_link","args":["subreddit","标题","https://example.com"],"namedArgs":{"text":"补充说明"}}'

# 删帖
--tool site_run --args '{"name":"reddit/delete","args":["t3_xxxxxx"]}'
--tool site_run --args '{"name":"reddit/delete","args":["t3_aaa,t3_bbb,t3_ccc"]}'
```

**`reddit/post_text` 参数**

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `subreddit` | `args[0]` | 是 | 不含 `r/` 前缀 |
| `title` | `args[1]` | 是 | 最长 300 字符 |
| `text` | `args[2]` | 否 | 正文（Markdown） |
| `flair_id` | `namedArgs` | 否 | 由 `reddit/flairs` 返回 |
| `flair_text` | `namedArgs` | 否 | 仅 `text_editable=true` 时生效 |
| `nsfw` | `namedArgs` | 否 | `"true"` 标记 NSFW |
| `spoiler` | `namedArgs` | 否 | `"true"` 标记剧透 |

**`reddit/post_link` 参数**

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `subreddit` | `args[0]` | 是 | 不含 `r/` 前缀 |
| `title` | `args[1]` | 是 | 最长 300 字符 |
| `url` | `args[2]` | 是 | 链接帖目标 URL |
| `text` | `namedArgs` | 否 | 链接下方补充说明（Markdown） |
| `flair_id` | `namedArgs` | 否 | 由 `reddit/flairs` 返回 |
| `nsfw` | `namedArgs` | 否 | `"true"` 标记 NSFW |
| `spoiler` | `namedArgs` | 否 | `"true"` 标记剧透 |

## 📺 B站

```bash
--tool site_run --args '{"name":"bilibili/popular"}'
--tool site_run --args '{"name":"bilibili/ranking"}'
--tool site_run --args '{"name":"bilibili/search","args":["关键词"]}'
--tool site_run --args '{"name":"bilibili/comments","args":["视频BV号"]}'
```

## 💡 知乎

```bash
--tool site_run --args '{"name":"zhihu/hot"}'
--tool site_run --args '{"name":"zhihu/search","args":["关键词"]}'
--tool site_run --args '{"name":"zhihu/question","args":["问题ID"]}'
```

## 👨‍💻 GitHub

```bash
--tool site_run --args '{"name":"github/repo","args":["owner/repo"]}'
--tool site_run --args '{"name":"github/issues","args":["owner/repo"]}'
```

## 🔍 搜索引擎

```bash
--tool site_run --args '{"name":"google/search","args":["关键词"]}'
--tool site_run --args '{"name":"bing/search","args":["关键词"]}'
--tool site_run --args '{"name":"baidu/search","args":["关键词"]}'
```

## 💹 财经

```bash
--tool site_run --args '{"name":"xueqiu/stock","args":["代码"]}'
--tool site_run --args '{"name":"xueqiu/hot"}'
--tool site_run --args '{"name":"yahoo-finance/quote","args":["TICKER"]}'
```

## 📰 资讯

```bash
--tool site_run --args '{"name":"36kr/newsflash"}'
--tool site_run --args '{"name":"bbc/news"}'
--tool site_run --args '{"name":"toutiao/hot"}'
--tool site_run --args '{"name":"hackernews/top"}'
```
