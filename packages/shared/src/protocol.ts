/**
 * bb-browser 通信协议 — CLI ↔ Daemon ↔ Chrome CDP
 */

/** 支持的操作类型 */
export type ActionType =
  | "open"
  | "snap"
  | "click"
  | "hover"
  | "fill"
  | "type"
  | "check"
  | "uncheck"
  | "select"
  | "get"
  | "screenshot"
  | "close"
  | "press"
  | "scroll"
  | "back"
  | "forward"
  | "reload"
  | "eval"
  | "tab_list"
  | "tab_new"
  | "frame"
  | "frame_main"
  | "dialog"
  | "network"
  | "console"
  | "errors"
  | "trace"
  | "site_run"
  | "site_list"
  | "site_info"
  | "site_search"
  | "goto"
  | "cookies"
  | "source";

/** 请求类型 */
export interface Request {
  /** 操作类型 */
  method: ActionType;
  /** 目标 URL（open 操作时必填） */
  url?: string;
  /** 元素引用（click, fill, get 操作时使用） */
  ref?: string;
  /** 输入文本（fill 操作时使用） */
  text?: string;
  /** 获取属性类型（get 操作时使用） */
  attribute?: string;
  /** 截图保存路径（screenshot 操作时使用） */
  path?: string;
  /** 是否只输出可交互元素（snapshot 命令使用） */
  interactive?: boolean;
  /** 移除空结构节点（snapshot 命令使用） */
  compact?: boolean;
  /** 限制树深度（snapshot 命令使用） */
  maxDepth?: number;
  /** JavaScript 代码（eval 命令使用） */
  script?: string;
  /** 目标域名（eval 命令使用，自动路由到匹配的 Tab 或新建） */
  domain?: string;
  /** 传递给脚本的参数对象（eval 命令使用，JSON 序列化后注入脚本） */
  args?: Record<string, unknown>;
  /** 选项值（select 命令使用） */
  value?: string;
  /** 标签页索引（tab 命令使用） */
  index?: number;
  /** 标签页 ID（tab 命令使用，优先于 index） */
  tabId?: number | string;
  /** CSS 选择器（frame 命令使用，定位 iframe） */
  selector?: string;
  /** dialog 响应类型（dialog 命令使用） */
  dialogResponse?: "accept" | "dismiss";
  /** prompt 对话框的输入文本（dialog accept 时可选） */
  promptText?: string;
  /** network 子命令：requests, route, unroute, clear */
  networkCommand?: "requests" | "route" | "unroute" | "clear";
  /** network route 选项 */
  routeOptions?: {
    abort?: boolean;
    body?: string;
    status?: number;
    headers?: Record<string, string>;
  };
  /** 过滤字符串（network requests, console 使用） */
  filter?: string;
  /** network requests 是否包含 body/headers */
  withBody?: boolean;
  /** console 子命令：get, clear */
  consoleCommand?: "get" | "clear";
  /** errors 子命令：get, clear */
  errorsCommand?: "get" | "clear";
  /** trace 子命令：start, stop, status, events, body */
  traceCommand?: "start" | "stop" | "status" | "events" | "body";
  /** Request ID for trace body command */
  requestId?: string;
  /** Event type filter for trace events (action/request/response/navigation) */
  traceType?: string;
  /** 按键名（press 命令使用） */
  key?: string;
  /** 修饰键列表（press 命令使用） */
  modifiers?: string[];
  /** 滚动方向（scroll 命令使用） */
  direction?: string;
  /** 滚动距离（scroll 命令使用） */
  pixels?: number;
  /** 增量查询起点（observation 命令使用，支持 seq 数值或 "last_action"） */
  since?: number | "last_action";
  /** HTTP 方法过滤（network requests 使用） */
  httpMethod?: string;
  /** HTTP 状态码过滤（network requests 使用，支持 "4xx"/"5xx" 或具体数字） */
  status?: string;
  /** 返回条数限制（observation 命令使用） */
  limit?: number;
  /** Site adapter 名称（site_run, site_info 命令使用） */
  siteName?: string;
  /** Site adapter 参数（site_run 命令使用） */
  siteArgs?: Record<string, string>;
  /** 搜索查询字符串（site_search 命令使用） */
  query?: string;
  /** 是否包含 base64 数据（screenshot 命令使用） */
  includeBase64?: boolean;
  /** 排除静态资源（trace events / network requests 使用） */
  excludeStatic?: boolean;
  /** source 子命令：grep */
  sourceCommand?: string;
  /** source 搜索模式 */
  sourcePattern?: string;
}

/** 元素引用信息 */
export interface RefInfo {
  /** CDP backendDOMNodeId（主定位方式） */
  backendDOMNodeId?: number;
  /** 元素的 XPath（向后兼容） */
  xpath?: string;
  /** 可访问性角色 */
  role: string;
  /** 可访问名称 */
  name?: string;
  /** 标签名 */
  tagName?: string;
}

/** 标签页信息 */
export interface TabInfo {
  /** 标签页在窗口中的索引（0-based） */
  index: number;
  /** 标签页 URL */
  url: string;
  /** 标签页标题 */
  title: string;
  /** 是否是当前活动标签页 */
  active: boolean;
  /** 标签页 ID（CDP targetId 或 extension tabId） */
  tabId: number | string;
  /** 短标签页 ID（daemon 模式） */
  tab?: string;
}

/** Snapshot 命令返回的数据 */
export interface SnapshotData {
  /** 文本格式的可访问性树 */
  snapshot: string;
  /** 元素引用映射，key 为 ref ID */
  refs: Record<string, RefInfo>;
}

/** 网络请求信息 */
export interface NetworkRequestInfo {
  requestId: string;
  url: string;
  method: string;
  type: string;
  timestamp: number;
  status?: number;
  statusText?: string;
  failed?: boolean;
  failureReason?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyBase64?: boolean;
  responseBodyTruncated?: boolean;
  mimeType?: string;
  bodyError?: string;
}

/** 控制台消息 */
export interface ConsoleMessageInfo {
  type: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

/** JS 错误信息 */
export interface JSErrorInfo {
  message: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Trace — unified timeline of actions + network + navigation
// ---------------------------------------------------------------------------

/** Base fields shared by all trace entries */
interface TraceEntryBase {
  /** Global monotonic seq */
  seq: number;
  /** Millisecond timestamp (Date.now()) */
  ts: number;
  /** Tab shortId where the event occurred */
  tab: string;
}

/** User action (bb-browser command or human interaction) */
export interface TraceAction extends TraceEntryBase {
  type: 'action';
  /** Whether this action came from a bb-browser command or human interaction */
  source: 'command' | 'human';
  /** Action name: click, fill, type, press, scroll, select, check, open, ... */
  action: string;
  /** Element ref from snapshot */
  ref?: number;
  /** CSS selector (for human-captured events) */
  selector?: string;
  /** Visible text of the target element (truncated) */
  text?: string;
  /** Accessibility role */
  role?: string;
  /** HTML tag name */
  tag?: string;
  /** Input value (fill/type) */
  value?: string;
  /** Key name (press) */
  key?: string;
  /** Scroll direction */
  direction?: string;
  /** URL (for open/navigation actions) */
  url?: string;
}

/** Network request sent */
export interface TraceRequest extends TraceEntryBase {
  type: 'request';
  requestId: string;
  method: string;
  url: string;
  /** Resource type: XHR, Fetch, Document, Script, ... */
  resourceType: string;
  headers?: Record<string, string>;
  /** POST body */
  body?: string;
  /** Seq of the action that likely triggered this request */
  triggerSeq?: number;
}

/** Network response received */
export interface TraceResponse extends TraceEntryBase {
  type: 'response';
  /** Matches TraceRequest.requestId */
  requestId: string;
  status: number;
  mimeType?: string;
  bodySize?: number;
}

/** Page navigation */
export interface TraceNavigation extends TraceEntryBase {
  type: 'navigation';
  url: string;
  /** URL before navigation */
  from?: string;
}

/** Union of all trace entry types */
export type TraceEntry = TraceAction | TraceRequest | TraceResponse | TraceNavigation;

/** Trace session status */
export interface TraceStatus {
  /** Whether recording is active */
  recording: boolean;
  /** Total event count in the timeline */
  eventCount: number;
  /** Tabs being traced */
  tracedTabs?: string[];
}

/** 响应数据 */
export interface ResponseData {
  /** 页面标题 */
  title?: string;
  /** 当前 URL */
  url?: string;
  /** Tab ID */
  tabId?: number | string;
  /** 短标签页 ID（daemon 模式） */
  tab?: string;
  /** 全局操作序号 */
  seq?: number;
  /** 观测查询游标（用于 since 增量查询） */
  cursor?: number;
  /** Snapshot 数据（snapshot 操作返回） */
  snapshotData?: SnapshotData;
  /** 获取的文本或属性值（get 操作返回） */
  value?: string;
  /** 截图路径（screenshot 操作返回） */
  screenshotPath?: string;
  /** 截图 data URL（screenshot 操作返回） */
  dataUrl?: string;
  /** eval 执行结果 */
  result?: unknown;
  /** 标签页列表（tab_list 命令返回） */
  tabs?: TabInfo[];
  /** 当前活动标签页索引（tab_list 命令返回） */
  activeIndex?: number;
  /** Frame 信息（frame 命令返回） */
  frameInfo?: {
    /** iframe 的 CSS 选择器 */
    selector?: string;
    /** iframe 的 name 属性 */
    name?: string;
    /** iframe 的 URL */
    url?: string;
    /** frame ID */
    frameId?: number;
  };
  /** dialog 信息（dialog 命令返回） */
  dialogInfo?: {
    /** 对话框类型：alert, confirm, prompt, beforeunload */
    type: string;
    /** 对话框消息 */
    message: string;
    /** 是否成功处理 */
    handled: boolean;
  };
  /** 网络请求列表（network requests 命令返回） */
  networkRequests?: NetworkRequestInfo[];
  /** 网络路由规则数量（network route/unroute 命令返回） */
  routeCount?: number;
  /** 控制台消息列表（console 命令返回） */
  consoleMessages?: ConsoleMessageInfo[];
  /** JS 错误列表（errors 命令返回） */
  jsErrors?: JSErrorInfo[];
  /** Trace timeline entries (trace events/stop command) */
  traceEvents?: TraceEntry[];
  /** Trace session status */
  traceStatus?: TraceStatus;
  /** Trace response body (trace body command) */
  traceBody?: { requestId: string; body: string; base64Encoded: boolean; requestBody?: string };
  /** Cookies for the current page (cookies command) */
  cookies?: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }>;
  /** Source grep results (source command) */
  sourceResults?: Array<{ url: string; matches: string[] }>;
}

/** 错误信息 */
export interface ResponseError {
  /** 技术原因 */
  message: string;
  /** 人类可读提示 */
  hint?: string;
}

/** 响应类型 — result 和 error 互斥 */
export interface Response {
  /** 成功时返回的数据 */
  result?: ResponseData;
  /** 失败时的错误信息 */
  error?: ResponseError;
}

/** Daemon 状态 */
export interface DaemonStatus {
  running: boolean;
  cdpConnected: boolean;
  uptime: number;
  currentSeq?: number;
  tabs?: Array<{
    shortId: string;
    targetId: string;
    networkRequests: number;
    consoleMessages: number;
    jsErrors: number;
    lastActionSeq: number;
  }>;
}


