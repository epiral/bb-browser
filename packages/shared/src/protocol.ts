import { randomUUID } from "node:crypto";

/**
 * bb-browser 通信协议 — CLI/MCP ↔ Daemon ↔ Chrome CDP
 */

/** 支持的操作类型 */
export type ActionType =
  | "open"
  | "snapshot"
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
  | "wait"
  | "press"
  | "scroll"
  | "back"
  | "forward"
  | "refresh"
  | "eval"
  | "tab_list"
  | "tab_new"
  | "tab_select"
  | "tab_close"
  | "frame"
  | "frame_main"
  | "dialog"
  | "network"
  | "console"
  | "errors"
  | "trace"
  | "history";

/** 请求类型 */
export interface Request {
  /** 请求唯一标识 */
  id: string;
  /** 操作类型 */
  action: ActionType;
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
  /** 选项值（select 命令使用） */
  value?: string;
  /** 标签页索引（tab_select, tab_close 命令使用） */
  index?: number;
  /** 标签页 ID（tab_select, tab_close 命令使用，优先于 index） */
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
  /** trace 子命令：start, stop, status */
  traceCommand?: "start" | "stop" | "status";
  /** history 子命令：search, domains */
  historyCommand?: "search" | "domains";
  /** 按键名（press 命令使用） */
  key?: string;
  /** 修饰键列表（press 命令使用） */
  modifiers?: string[];
  /** 滚动方向（scroll 命令使用） */
  direction?: string;
  /** 滚动距离（scroll 命令使用） */
  pixels?: number;
  /** 等待类型（wait 命令使用） */
  waitType?: string;
  /** 等待毫秒数（wait 命令使用） */
  ms?: number;
  /** 增量查询起点（observation 命令使用，支持 seq 数值或 "last_action"） */
  since?: number | "last_action";
  /** HTTP 方法过滤（network requests 使用） */
  method?: string;
  /** HTTP 状态码过滤（network requests 使用，支持 "4xx"/"5xx" 或具体数字） */
  status?: string;
  /** 返回条数限制（observation 命令使用） */
  limit?: number;
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

/** Trace 事件类型 - 录制用户操作 */
export interface TraceEvent {
  /** 事件类型 */
  type: 'click' | 'fill' | 'select' | 'check' | 'press' | 'scroll' | 'navigation';
  /** 时间戳 */
  timestamp: number;
  /** 事件发生时的页面 URL */
  url: string;
  
  /** 元素引用 - highlightIndex，可直接用于 @ref */
  ref?: number;
  /** 备用定位 - XPath */
  xpath?: string;
  /** CSS 选择器 */
  cssSelector?: string;
  
  /** 操作参数 - fill/select 的值 */
  value?: string;
  /** 操作参数 - press 的按键 */
  key?: string;
  /** 操作参数 - scroll 方向 */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** 操作参数 - scroll 距离 */
  pixels?: number;
  /** 操作参数 - check/uncheck 状态 */
  checked?: boolean;
  
  /** 语义信息 - 元素角色 */
  elementRole?: string;
  /** 语义信息 - 元素名称 */
  elementName?: string;
  /** 语义信息 - 元素标签 */
  elementTag?: string;
}

/** Trace 录制状态 */
export interface TraceStatus {
  /** 是否正在录制 */
  recording: boolean;
  /** 已录制事件数量 */
  eventCount: number;
  /** 录制的标签页 ID */
  tabId?: number;
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
  /** Trace 事件列表（trace stop 命令返回） */
  traceEvents?: TraceEvent[];
  /** Trace 录制状态（trace status 命令返回） */
  traceStatus?: TraceStatus;
  /** History 搜索结果 */
  historyItems?: Array<{
    url: string;
    title: string;
    visitCount: number;
    lastVisitTime: number;
  }>;
  /** History 域名聚合结果 */
  historyDomains?: Array<{
    domain: string;
    visits: number;
    titles: string[];
  }>;
}

/** 响应类型 */
export interface Response {
  /** 对应请求的 ID */
  id: string;
  /** 操作是否成功 */
  success: boolean;
  /** 成功时返回的数据 */
  data?: ResponseData;
  /** 失败时的错误信息 */
  error?: string;
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

/**
 * 生成唯一请求 ID
 * @returns UUID v4 格式的字符串
 */
export function generateId(): string {
  return randomUUID();
}
