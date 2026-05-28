/**
 * bb-browser CLI 入口
 */

import { openCommand } from "./commands/open.js";
import { gotoCommand } from "./commands/goto.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { clickCommand } from "./commands/click.js";
import { hoverCommand } from "./commands/hover.js";
import { fillCommand } from "./commands/fill.js";
import { typeCommand } from "./commands/type.js";
import { closeCommand } from "./commands/close.js";
import { getCommand, type GetAttribute } from "./commands/get.js";
import { screenshotCommand } from "./commands/screenshot.js";
import { pressCommand } from "./commands/press.js";
import { scrollCommand } from "./commands/scroll.js";
import { backCommand, forwardCommand, reloadCommand } from "./commands/nav.js";
import { checkCommand, uncheckCommand } from "./commands/check.js";
import { selectCommand } from "./commands/select.js";
import { evalCommand } from "./commands/eval.js";
import { tabCommand } from "./commands/tab.js";
import { frameCommand, frameMainCommand } from "./commands/frame.js";
import { dialogCommand } from "./commands/dialog.js";
import { networkCommand } from "./commands/network.js";
import { consoleCommand } from "./commands/console.js";
import { errorsCommand } from "./commands/errors.js";
import { traceCommand } from "./commands/trace.js";
import { cookiesCommand } from "./commands/cookies.js";
import { sourceCommand as sourceCmd } from "./commands/source.js";
import { siteCommand } from "./commands/site.js";
import { shutdownCommand, startCommand, statusCommand } from "./commands/daemon.js";
import { getDaemonPath } from "./daemon-manager.js";
import { setJqExpression } from "./client.js";

declare const __BB_BROWSER_VERSION__: string;

const VERSION = __BB_BROWSER_VERSION__;

// Commands that require --tab
const TAB_REQUIRED_COMMANDS = new Set([
  "snap", "screenshot", "get",
  "click", "hover", "fill", "type", "check", "uncheck", "select",
  "press", "scroll", "back", "forward", "reload", "close",
  "frame", "dialog", "network", "console", "errors",
  "goto", "cookies", "source",
]);

// eval requires --tab unless --domain is provided
const TAB_OR_DOMAIN_COMMANDS = new Set(["eval"]);

const HELP_TEXT = `
bb-browser - AI Agent 浏览器自动化工具

安装：
  npm install -g bb-browser

提示：大多数数据获取任务请直接使用 site 命令，无需手动操作浏览器：
  bb-browser site list                    查看所有可用命令
  bb-browser site twitter/search "AI"     示例：搜索推文

用法：
  bb-browser <command> [options]

开始使用：
  site recommend               推荐你可能需要的 adapter（基于浏览历史）
  site list                    列出所有 adapter
  site info <name>             查看 adapter 用法（参数、返回值、示例）
  site <name> [args]           运行 adapter
  site update                  更新社区 adapter 库
  guide                        如何把任何网站变成 adapter
  star                         ⭐ Star bb-browser on GitHub

浏览器操作：
  open <url> [--tab]           打开 URL（新 tab 或指定 tab）
  goto <url> --tab <id>        在当前 tab 导航到新 URL（保持上下文）
  snap [-i] [-c] [-d <n>]     获取页面快照 (--tab required)
  click <ref>                  点击元素 (--tab required)
  hover <ref>                  悬停元素 (--tab required)
  fill <ref> <text>            填充输入框 (--tab required)
  type <ref> <text>            逐字符输入 (--tab required)
  check/uncheck <ref>          勾选/取消复选框 (--tab required)
  select <ref> <val>           下拉框选择 (--tab required)
  press <key>                  发送按键 (--tab required)
  scroll <dir> [px]            滚动页面 (--tab required)

页面信息：
  get text|url|title|value|html [ref]  获取页面内容 (--tab required)
  screenshot [path]            截图 (--tab required)
  eval "<js>" [--domain d]     执行 JavaScript (--tab or --domain)

标签页：
  tab [list|new]               管理标签页
  close                        关闭标签页 (--tab required)
  status                       查看受管浏览器状态

导航：
  back / forward / reload      后退 / 前进 / 刷新 (--tab required)

调试：
  network requests [filter]    查看网络请求 (--tab required)
  cookies [--filter <str>]     查看页面 cookies (--tab required)
  source grep <pattern>        搜索已加载 JS 源码 (--tab required)
  console [--clear]            查看/清空控制台 (--tab required)
  errors [--clear]             查看/清空 JS 错误 (--tab required)
  trace start [--tab <id>]     录制操作+网络的统一时间线
  trace events [--type action|request] 查看时间线（支持 --since/--filter/--tab）
  trace body <requestId>       获取某个请求的 response body
  trace stop                   停止录制（数据保留）
  trace status                 查看录制状态
  daemon [start|status|stop]   管理 daemon

选项：
  --json               以 JSON 格式输出
  --port <n>           指定 Chrome CDP 端口
  --openclaw           优先复用 OpenClaw 浏览器实例
  --jq <expr>          对 JSON 输出应用 jq 过滤
  -i, --interactive    只输出可交互元素（snap 命令）
  -c, --compact        移除空结构节点（snap 命令）
  -d, --depth <n>      限制树深度（snap 命令）
  -s, --selector <sel> 限定 CSS 选择器范围（snap 命令）
  --tab <tabId>        指定操作的标签页 ID
  --since <seq>        增量查询（network/console/errors/trace events）
  --type <t>           过滤事件类型（trace events: action/request/response）
  --filter <str>       URL 或文字过滤（trace events/network requests/cookies）
  --exclude-static     排除静态资源（trace events/network requests）
  --limit <n>          限制返回条数
  --request-id <id>    请求 ID（trace body）
  --help, -h           显示帮助信息
  --version, -v        显示版本号
`.trim();

interface ParsedArgs {
  command: string | null;
  args: string[];
  flags: {
    json: boolean;
    help: boolean;
    version: boolean;
    interactive: boolean;
    compact: boolean;
    depth?: number;
    selector?: string;
    tab?: string;
    days?: number;
    jq?: string;
    openclaw?: boolean;
    port?: number;
    since?: string;
    domain?: string;
    args?: string;
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  const result: ParsedArgs = {
    command: null,
    args: [],
    flags: {
      json: false,
      help: false,
      version: false,
      interactive: false,
      compact: false,
    },
  };

  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--json") {
      result.flags.json = true;
    } else if (arg === "--jq") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        result.flags.jq = args[nextIdx];
        result.flags.json = true;
      }
    } else if (arg === "--openclaw") {
      result.flags.openclaw = true;
    } else if (arg === "--port") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        result.flags.port = parseInt(args[nextIdx], 10);
      }
    } else if (arg === "--help" || arg === "-h") {
      result.flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      result.flags.version = true;
    } else if (arg === "--interactive" || arg === "-i") {
      result.flags.interactive = true;
    } else if (arg === "--compact" || arg === "-c") {
      result.flags.compact = true;
    } else if (arg === "--depth" || arg === "-d") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        result.flags.depth = parseInt(args[nextIdx], 10);
      }
    } else if (arg === "--selector" || arg === "-s") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        result.flags.selector = args[nextIdx];
      }
    } else if (arg === "--days") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        result.flags.days = parseInt(args[nextIdx], 10);
      }
    } else if (arg === "--id") {
      skipNext = true;
    } else if (arg === "--tab") {
      skipNext = true;
    } else if (arg === "--domain") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        result.flags.domain = args[nextIdx];
      }
    } else if (arg === "--args") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        result.flags.args = args[nextIdx];
      }
    } else if (arg === "--since") {
      skipNext = true;
    } else if (arg === "--method") {
      skipNext = true;
    } else if (arg === "--status") {
      skipNext = true;
    } else if (arg === "--type") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        (result.flags as Record<string, unknown>).type = args[nextIdx];
      }
    } else if (arg === "--filter") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        (result.flags as Record<string, unknown>).filter = args[nextIdx];
      }
    } else if (arg === "--limit") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        (result.flags as Record<string, unknown>).limit = parseInt(args[nextIdx], 10);
      }
    } else if (arg === "--request-id") {
      skipNext = true;
      const nextIdx = args.indexOf(arg) + 1;
      if (nextIdx < args.length) {
        (result.flags as Record<string, unknown>)["request-id"] = args[nextIdx];
      }
    } else if (arg === "--exclude-static") {
      (result.flags as Record<string, unknown>).excludeStatic = true;
    } else if (arg.startsWith("-")) {
      // Unknown flags, ignore
    } else if (result.command === null) {
      result.command = arg;
    } else {
      result.args.push(arg);
    }
  }

  return result;
}

/**
 * Check --tab requirement at CLI level.
 * Returns the tab ID string or exits with error.
 */
function requireTab(command: string, globalTabId: string | undefined): string {
  if (!globalTabId) {
    console.error(`Missing --tab. Run 'bb-browser tab list' to see open tabs.`);
    process.exit(1);
  }
  return globalTabId;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  setJqExpression(parsed.flags.jq);

  // Parse global --tab
  const tabArgIdx = process.argv.indexOf('--tab');
  const globalTabId = tabArgIdx >= 0 && process.argv[tabArgIdx + 1]
    ? process.argv[tabArgIdx + 1]
    : undefined;

  // Parse global --since
  const sinceArgIdx = process.argv.indexOf('--since');
  const globalSince = sinceArgIdx >= 0 && process.argv[sinceArgIdx + 1]
    ? process.argv[sinceArgIdx + 1]
    : undefined;

  if (parsed.flags.version) {
    console.log(VERSION);
    return;
  }

  if (!parsed.command) {
    console.log(HELP_TEXT);
    return;
  }

  if (parsed.flags.help && parsed.command !== "daemon") {
    console.log(HELP_TEXT);
    return;
  }

  // Enforce --tab for commands that require it
  if (TAB_REQUIRED_COMMANDS.has(parsed.command) && !globalTabId) {
    console.error(`Missing --tab. Run 'bb-browser tab list' to see open tabs.`);
    process.exit(1);
  }

  try {
    switch (parsed.command) {
      case "open": {
        const url = parsed.args[0];
        if (!url) {
          console.error("错误：缺少 URL 参数");
          console.error("用法：bb-browser open <url> [--tab current|<tabId>]");
          process.exit(1);
        }
        const tabIndex = process.argv.findIndex(a => a === "--tab");
        const tab = tabIndex >= 0 ? process.argv[tabIndex + 1] : undefined;
        await openCommand(url, { json: parsed.flags.json, tab });
        break;
      }

      case "goto": {
        const gotoUrl = parsed.args[0];
        if (!gotoUrl) {
          console.error("用法：bb-browser goto <url> --tab <tabId>");
          process.exit(1);
        }
        await gotoCommand(gotoUrl, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "snap": {
        await snapshotCommand({
          json: parsed.flags.json,
          interactive: parsed.flags.interactive,
          compact: parsed.flags.compact,
          maxDepth: parsed.flags.depth,
          selector: parsed.flags.selector,
          tabId: globalTabId,
        });
        break;
      }

      case "click": {
        const ref = parsed.args[0];
        if (!ref) {
          console.error("错误：缺少 ref 参数");
          console.error("用法：bb-browser click <ref> --tab <tabId>");
          process.exit(1);
        }
        await clickCommand(ref, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "hover": {
        const ref = parsed.args[0];
        if (!ref) {
          console.error("错误：缺少 ref 参数");
          process.exit(1);
        }
        await hoverCommand(ref, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "check": {
        const ref = parsed.args[0];
        if (!ref) {
          console.error("错误：缺少 ref 参数");
          process.exit(1);
        }
        await checkCommand(ref, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "uncheck": {
        const ref = parsed.args[0];
        if (!ref) {
          console.error("错误：缺少 ref 参数");
          process.exit(1);
        }
        await uncheckCommand(ref, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "fill": {
        const ref = parsed.args[0];
        const text = parsed.args[1];
        if (!ref || text === undefined) {
          console.error("用法：bb-browser fill <ref> <text> --tab <tabId>");
          process.exit(1);
        }
        await fillCommand(ref, text, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "type": {
        const ref = parsed.args[0];
        const text = parsed.args[1];
        if (!ref || text === undefined) {
          console.error("用法：bb-browser type <ref> <text> --tab <tabId>");
          process.exit(1);
        }
        await typeCommand(ref, text, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "select": {
        const ref = parsed.args[0];
        const value = parsed.args[1];
        if (!ref || value === undefined) {
          console.error("用法：bb-browser select <ref> <value> --tab <tabId>");
          process.exit(1);
        }
        await selectCommand(ref, value, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "eval": {
        const script = parsed.args[0];
        if (!script) {
          console.error("用法：bb-browser eval <script> [--tab <tabId>] [--domain <domain>] [--args <json>]");
          process.exit(1);
        }
        if (!globalTabId && !parsed.flags.domain) {
          console.error("Missing --tab or --domain. Run 'bb-browser tab list' to see open tabs.");
          process.exit(1);
        }
        await evalCommand(script, {
          json: parsed.flags.json,
          tabId: globalTabId,
          domain: parsed.flags.domain,
          args: parsed.flags.args,
        });
        break;
      }

      case "get": {
        const attribute = parsed.args[0] as GetAttribute | undefined;
        if (!attribute) {
          console.error("用法：bb-browser get <text|url|title|value|html> [ref] --tab <tabId>");
          process.exit(1);
        }
        if (!["text", "url", "title", "value", "html"].includes(attribute)) {
          console.error(`错误：未知属性 "${attribute}"`);
          console.error("支持的属性：text, url, title, value, html");
          process.exit(1);
        }
        const ref = parsed.args[1];
        await getCommand(attribute, ref, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "daemon": {
        const daemonSubcommand = parsed.args[0];
        if (daemonSubcommand === "status") {
          await statusCommand({ json: parsed.flags.json });
          break;
        }
        if (daemonSubcommand === "stop" || daemonSubcommand === "shutdown") {
          await shutdownCommand({ json: parsed.flags.json });
          break;
        }
        if (daemonSubcommand === "start") {
          await startCommand({ json: parsed.flags.json });
          break;
        }

        const daemonPath = getDaemonPath();
        const daemonArgs = process.argv.slice(3);
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, [daemonPath, ...daemonArgs], {
          stdio: "inherit",
        });
        child.on("exit", (code, signal) => {
          if (signal) {
            process.kill(process.pid, signal);
            return;
          }
          process.exit(code ?? 0);
        });
        return;
      }

      case "close": {
        await closeCommand({ json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "back": {
        await backCommand({ json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "forward": {
        await forwardCommand({ json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "reload": {
        await reloadCommand({ json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "screenshot": {
        const outputPath = parsed.args[0];
        await screenshotCommand(outputPath, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "press": {
        const key = parsed.args[0];
        if (!key) {
          console.error("用法：bb-browser press <key> --tab <tabId>");
          process.exit(1);
        }
        await pressCommand(key, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "scroll": {
        const direction = parsed.args[0];
        const pixels = parsed.args[1];
        if (!direction) {
          console.error("用法：bb-browser scroll <up|down|left|right> [pixels] --tab <tabId>");
          process.exit(1);
        }
        await scrollCommand(direction, pixels, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "tab": {
        await tabCommand(parsed.args, { json: parsed.flags.json, globalTabId });
        break;
      }

      case "status": {
        await statusCommand({ json: parsed.flags.json });
        break;
      }

      case "frame": {
        const selectorOrMain = parsed.args[0];
        if (!selectorOrMain) {
          console.error("用法：bb-browser frame <selector> --tab <tabId>");
          console.error("      bb-browser frame main --tab <tabId>");
          process.exit(1);
        }
        if (selectorOrMain === "main") {
          await frameMainCommand({ json: parsed.flags.json, tabId: globalTabId });
        } else {
          await frameCommand(selectorOrMain, { json: parsed.flags.json, tabId: globalTabId });
        }
        break;
      }

      case "dialog": {
        const subCommand = parsed.args[0];
        if (!subCommand) {
          console.error("用法：bb-browser dialog <accept|dismiss> [text] --tab <tabId>");
          process.exit(1);
        }
        const promptText = parsed.args[1];
        await dialogCommand(subCommand, promptText, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "network": {
        const subCommand = parsed.args[0] || "requests";
        const urlOrFilter = parsed.args[1];
        const abort = process.argv.includes("--abort");
        const withBody = process.argv.includes("--with-body");
        const bodyIndex = process.argv.findIndex(a => a === "--body");
        const body = bodyIndex >= 0 ? process.argv[bodyIndex + 1] : undefined;
        const methodIndex = process.argv.findIndex(a => a === "--method");
        const method = methodIndex >= 0 ? process.argv[methodIndex + 1] : undefined;
        const statusIndex = process.argv.findIndex(a => a === "--status");
        const statusFilter = statusIndex >= 0 ? process.argv[statusIndex + 1] : undefined;
        const excludeStatic = process.argv.includes("--exclude-static");
        await networkCommand(subCommand, urlOrFilter, { json: parsed.flags.json, abort, body, withBody, tabId: globalTabId, since: globalSince, method, status: statusFilter, excludeStatic });
        break;
      }

      case "console": {
        const clear = process.argv.includes("--clear");
        await consoleCommand({ json: parsed.flags.json, clear, tabId: globalTabId, since: globalSince });
        break;
      }

      case "errors": {
        const clear = process.argv.includes("--clear");
        await errorsCommand({ json: parsed.flags.json, clear, tabId: globalTabId, since: globalSince });
        break;
      }

      case "cookies": {
        const f = parsed.flags as Record<string, unknown>;
        await cookiesCommand({
          json: parsed.flags.json,
          tabId: globalTabId,
          filter: f.filter as string | undefined,
        });
        break;
      }

      case "source": {
        const srcSubCmd = parsed.args[0];
        const srcPattern = parsed.args[1];
        if (!srcSubCmd || !srcPattern) {
          console.error("用法：bb-browser source grep <pattern> --tab <tabId>");
          process.exit(1);
        }
        await sourceCmd(srcSubCmd, srcPattern, { json: parsed.flags.json, tabId: globalTabId });
        break;
      }

      case "trace": {
        const subCmd = parsed.args[0] as 'start' | 'stop' | 'status' | 'events' | 'body' | undefined;
        if (!subCmd || !['start', 'stop', 'status', 'events', 'body'].includes(subCmd)) {
          console.error("用法：bb-browser trace <start|stop|status|events|body> [--tab <tabId>]");
          process.exit(1);
        }
        const f = parsed.flags as Record<string, unknown>;
        await traceCommand(subCmd, {
          json: parsed.flags.json,
          tabId: globalTabId,
          since: globalSince,
          type: f.type as string | undefined,
          filter: f.filter as string | undefined,
          limit: f.limit as number | undefined,
          requestId: (f["request-id"] as string | undefined) || parsed.args[1],
          excludeStatic: f.excludeStatic as boolean | undefined,
        });
        break;
      }

      case "site": {
        await siteCommand(parsed.args, {
          json: parsed.flags.json,
          jq: parsed.flags.jq,
          days: parsed.flags.days,
          tabId: globalTabId,
          openclaw: parsed.flags.openclaw,
        });
        break;
      }

      case "star": {
        const { execSync } = await import("node:child_process");
        try {
          execSync("gh auth status", { stdio: "pipe" });
        } catch {
          console.error("需要先安装并登录 GitHub CLI: https://cli.github.com");
          process.exit(1);
        }
        const repos = ["epiral/bb-browser", "epiral/bb-sites"];
        for (const repo of repos) {
          try {
            execSync(`gh api user/starred/${repo} -X PUT`, { stdio: "pipe" });
            console.log(`Starred ${repo}`);
          } catch {
            console.log(`Already starred or failed: ${repo}`);
          }
        }
        console.log("\nThanks for your support!");
        break;
      }

      case "guide": {
        console.log(`How to turn any website into a bb-browser site adapter
=======================================================

1. REVERSE ENGINEER the API
   bb-browser network clear --tab <tabId>
   bb-browser reload --tab <tabId>
   bb-browser network requests --filter "api" --with-body --json --tab <tabId>

2. TEST if direct fetch works (Tier 1)
   bb-browser eval "fetch('/api/endpoint',{credentials:'include'}).then(r=>r.json())" --tab <tabId>

3. WRITE the adapter (one JS file per operation)

4. TEST it
   Save to ~/.bb-browser/sites/platform/command.js (private, takes priority)
   bb-browser site platform/command "test query" --json

5. CONTRIBUTE
   Full guide: https://github.com/epiral/bb-sites/blob/main/SKILL.md`);
        break;
      }

      default: {
        console.error(`错误：未知命令 "${parsed.command}"`);
        console.error("运行 bb-browser --help 查看可用命令");
        process.exit(1);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (parsed.flags.json) {
      console.log(
        JSON.stringify({
          error: { message },
        })
      );
    } else {
      console.error(`错误：${message}`);
    }

    process.exit(1);
  }
}

main().then(() => process.exit(0));
