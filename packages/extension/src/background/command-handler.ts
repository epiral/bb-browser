/**
 * Command Handler for bb-browser Extension
 * 处理从 Daemon 接收的命令
 * 
 * v2.0: 使用 CDP (chrome.debugger) 实现所有 DOM 操作
 */

import { sendResult, CommandResult } from './api-client';
import { CommandEvent } from './sse-client';
import * as cdp from './cdp-service';
import * as cdpDom from './cdp-dom-service';
import { cleanupTab as cleanupCdpTab } from './cdp-dom-service';
import { cleanupTab as cleanupDomTab } from './dom-service';
import * as traceService from './trace-service';

// 初始化 CDP 事件监听器
cdp.initEventListeners();

/**
 * 每个 tab 的活动 Frame 的 frameId
 * null 表示主 frame，数字表示子 frame 的 frameId
 * 用于 handleFrame 内部逻辑，DOM 操作使用 dom-service 的 activeFrameId
 */
const tabActiveFrameId = new Map<number, number | null>();

/**
 * 根据命令解析目标 tab
 * 如果 command.tabId 是 number，用它直接获取 tab
 * 否则 fallback 到当前活跃 tab
 */
async function resolveTab(command: CommandEvent): Promise<chrome.tabs.Tab> {
  if (command.tabId !== undefined && typeof command.tabId === 'number') {
    return chrome.tabs.get(command.tabId);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found');
  }
  return tab;
}

/**
 * 处理收到的命令
 */
export async function handleCommand(command: CommandEvent): Promise<void> {
  console.log('[CommandHandler] Processing command:', command.id, command.action);

  let result: CommandResult;

  try {
    switch (command.action) {
      case 'open':
        result = await handleOpen(command);
        break;

      case 'snapshot':
        result = await handleSnapshot(command);
        break;

      case 'click':
        result = await handleClick(command);
        break;

      case 'hover':
        result = await handleHover(command);
        break;

      case 'fill':
        result = await handleFill(command);
        break;

      case 'type':
        result = await handleType(command);
        break;

      case 'check':
        result = await handleCheck(command);
        break;

      case 'uncheck':
        result = await handleUncheck(command);
        break;

      case 'close':
        result = await handleClose(command);
        break;

      case 'get':
        result = await handleGet(command);
        break;

      case 'screenshot':
        result = await handleScreenshot(command);
        break;

      case 'wait':
        result = await handleWait(command);
        break;

      case 'press':
        result = await handlePress(command);
        break;

      case 'scroll':
        result = await handleScroll(command);
        break;

      case 'back':
        result = await handleBack(command);
        break;

      case 'forward':
        result = await handleForward(command);
        break;

      case 'refresh':
        result = await handleRefresh(command);
        break;

      case 'eval':
        result = await handleEval(command);
        break;

      case 'select':
        result = await handleSelect(command);
        break;

      case 'tab_list':
        result = await handleTabList(command);
        break;

      case 'tab_new':
        result = await handleTabNew(command);
        break;

      case 'tab_select':
        result = await handleTabSelect(command);
        break;

      case 'tab_close':
        result = await handleTabClose(command);
        break;

      case 'frame':
        result = await handleFrame(command);
        break;

      case 'frame_main':
        result = await handleFrameMain(command);
        break;

      case 'dialog':
        result = await handleDialog(command);
        break;

      case 'network':
        result = await handleNetwork(command);
        break;

      case 'console':
        result = await handleConsole(command);
        break;

      case 'errors':
        result = await handleErrors(command);
        break;

      case 'trace':
        result = await handleTrace(command);
        break;

      case 'history':
        result = await handleHistory(command);
        break;

      default:
        result = {
          id: command.id,
          success: false,
          error: `Unknown action: ${command.action}`,
        };
    }
  } catch (error) {
    result = {
      id: command.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await sendResult(result);
}

/**
 * 处理 open 命令 - 打开 URL
 * 
 * 参数：
 *   - url: 要打开的 URL
 *   - tabId: 可选，指定在哪个 tab 中打开
 *     - undefined: 创建新 tab（默认，并发安全）
 *     - "current": 在当前活动 tab 中导航
 *     - number: 在指定 tabId 的 tab 中导航
 */
async function handleOpen(command: CommandEvent): Promise<CommandResult> {
  const url = command.url as string;
  const tabIdParam = command.tabId as string | number | undefined;

  if (!url) {
    return {
      id: command.id,
      success: false,
      error: 'Missing url parameter',
    };
  }

  console.log('[CommandHandler] Opening URL:', url, 'tabId:', tabIdParam);

  let tab: chrome.tabs.Tab;

  if (tabIdParam === undefined) {
    // 默认行为：创建新 tab（并发安全）
    tab = await chrome.tabs.create({ url, active: true });
  } else if (tabIdParam === "current") {
    // 在当前活动 tab 中导航
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (activeTab && activeTab.id) {
      tab = await chrome.tabs.update(activeTab.id, { url });
    } else {
      // 没有活动 tab，创建新的
      tab = await chrome.tabs.create({ url, active: true });
    }
  } else {
    // 在指定 tabId 的 tab 中导航
    const targetTabId = typeof tabIdParam === 'number' ? tabIdParam : parseInt(String(tabIdParam), 10);
    
    if (isNaN(targetTabId)) {
      return {
        id: command.id,
        success: false,
        error: `Invalid tabId: ${tabIdParam}`,
      };
    }

    try {
      tab = await chrome.tabs.update(targetTabId, { url, active: true });
    } catch (error) {
      return {
        id: command.id,
        success: false,
        error: `Tab ${targetTabId} not found or cannot be updated`,
      };
    }
  }

  // 等待页面加载完成
  await waitForTabLoad(tab.id!);

  // 获取页面信息
  const updatedTab = await chrome.tabs.get(tab.id!);

  return {
    id: command.id,
    success: true,
    data: {
      tabId: tab.id,
      title: updatedTab.title || '',
      url: updatedTab.url || url,
    },
  };
}

/**
 * 处理 snapshot 命令 - 获取页面快照
 * v2.0: 使用 CDP Accessibility.getFullAXTree 获取可访问性树
 */
async function handleSnapshot(command: CommandEvent): Promise<CommandResult> {
  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  // 检查是否是特殊页面（chrome:// 或 about:）
  const url = activeTab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
    return {
      id: command.id,
      success: false,
      error: `Cannot take snapshot of restricted page: ${url}`,
    };
  }

  // 提取 snapshot 参数
  const interactive = command.interactive as boolean | undefined;
  const compact = command.compact as boolean | undefined;
  const maxDepth = command.maxDepth as number | undefined;
  // snapshot 复用 selector 字段（也被 frame 命令使用）
  const selector = command.selector as string | undefined;

  console.log('[CommandHandler] Taking snapshot of tab:', activeTab.id, activeTab.url, { interactive, compact, maxDepth, selector });

  try {
    const snapshotResult = await cdpDom.getSnapshot(activeTab.id, { interactive, compact, maxDepth, selector });

    return {
      id: command.id,
      success: true,
      data: {
        title: activeTab.title || '',
        url: activeTab.url || '',
        snapshotData: snapshotResult,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Snapshot failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 click 命令 - 点击元素
 * v2.0: 使用 CDP Input.dispatchMouseEvent
 */
async function handleClick(command: CommandEvent): Promise<CommandResult> {
  const ref = command.ref as string;

  if (!ref) {
    return {
      id: command.id,
      success: false,
      error: 'Missing ref parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Clicking element:', ref);

  try {
    // v2.0: 使用 CDP DOM Service
    const elementInfo = await cdpDom.clickElement(activeTab.id, ref);

    return {
      id: command.id,
      success: true,
      data: {
        role: elementInfo.role,
        name: elementInfo.name,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Click failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Click failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 hover 命令 - 悬停在元素上
 * v2.0: 使用 CDP Input.dispatchMouseEvent
 */
async function handleHover(command: CommandEvent): Promise<CommandResult> {
  const ref = command.ref as string;

  if (!ref) {
    return {
      id: command.id,
      success: false,
      error: 'Missing ref parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Hovering element:', ref);

  try {
    // v2.0: 使用 CDP DOM Service
    const elementInfo = await cdpDom.hoverElement(activeTab.id, ref);

    return {
      id: command.id,
      success: true,
      data: {
        role: elementInfo.role,
        name: elementInfo.name,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Hover failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Hover failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 fill 命令 - 填充输入框
 */
async function handleFill(command: CommandEvent): Promise<CommandResult> {
  const ref = command.ref as string;
  const text = command.text as string;

  if (!ref) {
    return {
      id: command.id,
      success: false,
      error: 'Missing ref parameter',
    };
  }

  if (text === undefined || text === null) {
    return {
      id: command.id,
      success: false,
      error: 'Missing text parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Filling element:', ref, 'with text length:', text.length);

  try {
    // v2.0: 使用 CDP DOM Service
    const elementInfo = await cdpDom.fillElement(activeTab.id, ref, text);

    return {
      id: command.id,
      success: true,
      data: {
        role: elementInfo.role,
        name: elementInfo.name,
        filledText: text,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Fill failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Fill failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 type 命令 - 逐字符输入文本（不清空原有内容）
 * v2.0: 使用 CDP Input.dispatchKeyEvent
 */
async function handleType(command: CommandEvent): Promise<CommandResult> {
  const ref = command.ref as string;
  const text = command.text as string;

  if (!ref) {
    return {
      id: command.id,
      success: false,
      error: 'Missing ref parameter',
    };
  }

  if (text === undefined || text === null) {
    return {
      id: command.id,
      success: false,
      error: 'Missing text parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Typing in element:', ref, 'text length:', text.length);

  try {
    // v2.0: 使用 CDP DOM Service
    const elementInfo = await cdpDom.typeElement(activeTab.id, ref, text);

    return {
      id: command.id,
      success: true,
      data: {
        role: elementInfo.role,
        name: elementInfo.name,
        typedText: text,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Type failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Type failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 check 命令 - 勾选复选框
 */
async function handleCheck(command: CommandEvent): Promise<CommandResult> {
  const ref = command.ref as string;

  if (!ref) {
    return {
      id: command.id,
      success: false,
      error: 'Missing ref parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Checking element:', ref);

  try {
    // v2.0: 使用 CDP DOM Service
    const elementInfo = await cdpDom.checkElement(activeTab.id, ref);

    return {
      id: command.id,
      success: true,
      data: {
        role: elementInfo.role,
        name: elementInfo.name,
        wasAlreadyChecked: elementInfo.wasAlreadyChecked,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Check failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 uncheck 命令 - 取消勾选复选框
 * v2.0: 使用 CDP Runtime.callFunctionOn
 */
async function handleUncheck(command: CommandEvent): Promise<CommandResult> {
  const ref = command.ref as string;

  if (!ref) {
    return {
      id: command.id,
      success: false,
      error: 'Missing ref parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Unchecking element:', ref);

  try {
    // v2.0: 使用 CDP DOM Service
    const elementInfo = await cdpDom.uncheckElement(activeTab.id, ref);

    return {
      id: command.id,
      success: true,
      data: {
        role: elementInfo.role,
        name: elementInfo.name,
        wasAlreadyUnchecked: elementInfo.wasAlreadyUnchecked,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Uncheck failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Uncheck failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 select 命令 - 下拉框选择
 * v2.0: 使用 CDP Runtime.callFunctionOn
 */
async function handleSelect(command: CommandEvent): Promise<CommandResult> {
  const ref = command.ref as string;
  const value = command.value as string;

  if (!ref) {
    return {
      id: command.id,
      success: false,
      error: 'Missing ref parameter',
    };
  }

  if (value === undefined || value === null) {
    return {
      id: command.id,
      success: false,
      error: 'Missing value parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Selecting option:', ref, 'value:', value);

  try {
    // v2.0: 使用 CDP DOM Service
    const result = await cdpDom.selectOption(activeTab.id, ref, value);

    return {
      id: command.id,
      success: true,
      data: {
        role: result.role,
        name: result.name,
        selectedValue: result.selectedValue,
        selectedLabel: result.selectedLabel,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Select failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Select failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 close 命令 - 关闭当前标签页
 */
async function handleClose(command: CommandEvent): Promise<CommandResult> {
  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;
  const title = activeTab.title || '';
  const url = activeTab.url || '';

  console.log('[CommandHandler] Closing tab:', tabId, url);

  try {
    await chrome.tabs.remove(tabId);

    // 清理 tab 相关状态
    cleanupDomTab(tabId);
    cleanupCdpTab(tabId);
    tabActiveFrameId.delete(tabId);

    return {
      id: command.id,
      success: true,
      data: {
        tabId,
        title,
        url,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Close failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Close failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 get 命令 - 获取页面或元素信息
 */
async function handleGet(command: CommandEvent): Promise<CommandResult> {
  const attribute = command.attribute as string;

  if (!attribute) {
    return {
      id: command.id,
      success: false,
      error: 'Missing attribute parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Getting:', attribute);

  try {
    let value: string;

    switch (attribute) {
      case 'url':
        value = activeTab.url || '';
        break;

      case 'title':
        value = activeTab.title || '';
        break;

      case 'text': {
        const ref = command.ref as string;
        if (!ref) {
          return {
            id: command.id,
            success: false,
            error: 'Missing ref parameter for get text',
          };
        }
        // v2.0: 使用 CDP DOM Service
        value = await cdpDom.getElementText(activeTab.id, ref);
        break;
      }

      default:
        return {
          id: command.id,
          success: false,
          error: `Unknown attribute: ${attribute}`,
        };
    }

    return {
      id: command.id,
      success: true,
      data: {
        value,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Get failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Get failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 screenshot 命令 - 截取当前页面
 */
async function handleScreenshot(command: CommandEvent): Promise<CommandResult> {
  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id || !activeTab.windowId) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Taking screenshot of tab:', activeTab.id, activeTab.url);

  try {
    // 使用 chrome.tabs.captureVisibleTab 截图
    const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });

    return {
      id: command.id,
      success: true,
      data: {
        dataUrl,
        title: activeTab.title || '',
        url: activeTab.url || '',
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Screenshot failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 wait 命令 - 等待时间或元素
 */
async function handleWait(command: CommandEvent): Promise<CommandResult> {
  const waitType = command.waitType as string;

  if (waitType === 'time') {
    // 等待指定时间
    const ms = command.ms as number;
    if (!ms || ms < 0) {
      return {
        id: command.id,
        success: false,
        error: 'Invalid ms parameter',
      };
    }

    console.log('[CommandHandler] Waiting for', ms, 'ms');
    await new Promise(resolve => setTimeout(resolve, ms));

    return {
      id: command.id,
      success: true,
      data: { waited: ms },
    };
  } else if (waitType === 'element') {
    // 等待元素出现
    const ref = command.ref as string;
    if (!ref) {
      return {
        id: command.id,
        success: false,
        error: 'Missing ref parameter',
      };
    }

    // 获取目标标签页
    const activeTab = await resolveTab(command);

    if (!activeTab.id) {
      return {
        id: command.id,
        success: false,
        error: 'No active tab found',
      };
    }

    console.log('[CommandHandler] Waiting for element:', ref);

    try {
      // v2.0: 使用 CDP DOM Service
      await cdpDom.waitForElement(activeTab.id, ref);
      return {
        id: command.id,
        success: true,
        data: { ref },
      };
    } catch (error) {
      console.error('[CommandHandler] Wait failed:', error);
      return {
        id: command.id,
        success: false,
        error: `Wait failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    return {
      id: command.id,
      success: false,
      error: `Unknown wait type: ${waitType}`,
    };
  }
}

/**
 * 处理 press 命令 - 发送键盘按键
 */
async function handlePress(command: CommandEvent): Promise<CommandResult> {
  const key = command.key as string;
  const modifiers = (command.modifiers as string[]) || [];

  if (!key) {
    return {
      id: command.id,
      success: false,
      error: 'Missing key parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  // 检查是否是特殊页面
  const url = activeTab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
    return {
      id: command.id,
      success: false,
      error: `Cannot send keys to restricted page: ${url}`,
    };
  }

  console.log('[CommandHandler] Pressing key:', key, 'modifiers:', modifiers);

  try {
    // v2.0: 使用 CDP DOM Service
    await cdpDom.pressKey(activeTab.id, key, modifiers);

    const displayKey = modifiers.length > 0 ? `${modifiers.join('+')}+${key}` : key;

    return {
      id: command.id,
      success: true,
      data: {
        key: displayKey,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Press failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Press failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 scroll 命令 - 滚动页面
 * v2.0: 使用 CDP Input.dispatchMouseEvent (wheel)
 */
async function handleScroll(command: CommandEvent): Promise<CommandResult> {
  const direction = command.direction as string;
  const pixels = (command.pixels as number) || 300;

  if (!direction) {
    return {
      id: command.id,
      success: false,
      error: 'Missing direction parameter',
    };
  }

  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    return {
      id: command.id,
      success: false,
      error: `Invalid direction: ${direction}`,
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Scrolling:', direction, pixels, 'px');

  try {
    // v2.0: 使用 CDP DOM Service
    await cdpDom.scrollPage(activeTab.id, direction as 'up' | 'down' | 'left' | 'right', pixels);

    return {
      id: command.id,
      success: true,
      data: {
        direction,
        pixels,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Scroll failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Scroll failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 back 命令 - 后退
 * v2.0: 使用 CDP Runtime.evaluate
 */
async function handleBack(command: CommandEvent): Promise<CommandResult> {
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;
  console.log('[CommandHandler] Going back in tab:', tabId);

  try {
    // v2.0: 使用 CDP Service
    // 先检查是否可以后退
    const canGoBack = await cdp.evaluate(tabId, 'window.history.length > 1');
    
    if (!canGoBack) {
      return {
        id: command.id,
        success: false,
        error: 'No previous page in history',
      };
    }
    
    // 执行后退
    await cdp.evaluate(tabId, 'window.history.back()');
    
    // 等待页面加载
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const updatedTab = await chrome.tabs.get(tabId);

    return {
      id: command.id,
      success: true,
      data: {
        url: updatedTab.url || '',
        title: updatedTab.title || '',
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Back failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Back failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 forward 命令 - 前进
 * v2.0: 使用 CDP Runtime.evaluate
 */
async function handleForward(command: CommandEvent): Promise<CommandResult> {
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;
  console.log('[CommandHandler] Going forward in tab:', tabId);

  try {
    // v2.0: 使用 CDP Service
    await cdp.evaluate(tabId, 'window.history.forward()');
    
    // 等待页面加载
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const updatedTab = await chrome.tabs.get(tabId);

    return {
      id: command.id,
      success: true,
      data: {
        url: updatedTab.url || '',
        title: updatedTab.title || '',
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Forward failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Forward failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 refresh 命令 - 刷新页面
 */
async function handleRefresh(command: CommandEvent): Promise<CommandResult> {
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  console.log('[CommandHandler] Refreshing tab:', activeTab.id);

  try {
    await chrome.tabs.reload(activeTab.id);
    await waitForTabLoad(activeTab.id);
    const updatedTab = await chrome.tabs.get(activeTab.id);

    return {
      id: command.id,
      success: true,
      data: {
        url: updatedTab.url || '',
        title: updatedTab.title || '',
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Refresh failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 eval 命令 - 在页面执行 JavaScript
 * v2.0: 使用 CDP Runtime.evaluate
 */
async function handleEval(command: CommandEvent): Promise<CommandResult> {
  const script = command.script as string;

  if (!script) {
    return {
      id: command.id,
      success: false,
      error: 'Missing script parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  // 检查是否是特殊页面
  const url = activeTab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
    return {
      id: command.id,
      success: false,
      error: `Cannot execute script on restricted page: ${url}`,
    };
  }

  console.log('[CommandHandler] Evaluating script:', script.substring(0, 100));

  const tabId = activeTab.id;

  try {
    // v2.0: 使用 CDP Service
    const result = await cdp.evaluate(tabId, script);

    console.log('[CommandHandler] Eval result:', JSON.stringify(result));

    return {
      id: command.id,
      success: true,
      data: {
        result,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Eval failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Eval failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// v2.0: 状态管理已移到 cdp-service.ts

/**
 * 处理 tab_list 命令 - 列出所有标签页
 */
async function handleTabList(command: CommandEvent): Promise<CommandResult> {
  console.log('[CommandHandler] Listing all tabs');

  try {
    // 获取当前窗口的所有标签页
    const tabs = await chrome.tabs.query({ currentWindow: true });

    // 转换为 TabInfo 格式
    const tabInfos = tabs.map(tab => ({
      index: tab.index,
      url: tab.url || '',
      title: tab.title || '',
      active: tab.active || false,
      tabId: tab.id || 0,
    }));

    // 找到当前活动标签页的索引
    const activeTab = tabInfos.find(t => t.active);
    const activeIndex = activeTab?.index ?? 0;

    return {
      id: command.id,
      success: true,
      data: {
        tabs: tabInfos,
        activeIndex,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Tab list failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Tab list failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 tab_new 命令 - 新建标签页
 */
async function handleTabNew(command: CommandEvent): Promise<CommandResult> {
  const url = command.url as string | undefined;

  console.log('[CommandHandler] Creating new tab:', url || 'about:blank');

  try {
    const createOptions: chrome.tabs.CreateProperties = { active: true };
    if (url) {
      createOptions.url = url;
    }

    const tab = await chrome.tabs.create(createOptions);

    // 如果有 URL，等待页面加载完成
    if (url && tab.id) {
      await waitForTabLoad(tab.id);
    }

    // 获取最新的标签页信息
    const updatedTab = tab.id ? await chrome.tabs.get(tab.id) : tab;

    return {
      id: command.id,
      success: true,
      data: {
        tabId: updatedTab.id,
        title: updatedTab.title || '',
        url: updatedTab.url || '',
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Tab new failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Tab new failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 tab_select 命令 - 切换到指定标签页
 */
async function handleTabSelect(command: CommandEvent): Promise<CommandResult> {
  const index = command.index as number | undefined;
  const tabIdParam = command.tabId as number | undefined;

  if (index === undefined && tabIdParam === undefined) {
    return {
      id: command.id,
      success: false,
      error: 'Missing index or tabId parameter',
    };
  }

  console.log('[CommandHandler] Selecting tab:', tabIdParam !== undefined ? `tabId=${tabIdParam}` : `index=${index}`);

  try {
    let targetTab: chrome.tabs.Tab;

    if (tabIdParam !== undefined) {
      // 按 tabId 直接定位
      targetTab = await chrome.tabs.get(tabIdParam);
    } else {
      // 按 index 定位（兼容旧逻辑）
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const found = tabs.find(t => t.index === index);

      if (!found || !found.id) {
        return {
          id: command.id,
          success: false,
          error: `No tab found at index ${index} (total tabs: ${tabs.length})`,
        };
      }
      targetTab = found;
    }

    const targetTabId = targetTab.id!;

    // 仅设置 active 不会把标签页所在窗口切到前台，后续命令仍可能落在旧窗口。
    if (targetTab.windowId !== chrome.windows.WINDOW_ID_NONE) {
      await chrome.windows.update(targetTab.windowId, { focused: true });
    }

    // 激活标签页，并回读最新状态用于响应输出。
    const updatedTab = await chrome.tabs.update(targetTabId, { active: true });

    return {
      id: command.id,
      success: true,
      data: {
        tabId: updatedTab.id,
        title: updatedTab.title || '',
        url: updatedTab.url || '',
        index: updatedTab.index,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Tab select failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Tab select failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 tab_close 命令 - 关闭标签页
 */
async function handleTabClose(command: CommandEvent): Promise<CommandResult> {
  const index = command.index as number | undefined;
  const tabIdParam = command.tabId as number | undefined;

  console.log('[CommandHandler] Closing tab:', tabIdParam !== undefined ? `tabId=${tabIdParam}` : (index !== undefined ? `index=${index}` : 'current'));

  try {
    let targetTab: chrome.tabs.Tab;

    if (tabIdParam !== undefined) {
      // 按 tabId 直接定位
      targetTab = await chrome.tabs.get(tabIdParam);
    } else if (index !== undefined) {
      // 按 index 定位（兼容旧逻辑）
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const found = tabs.find(t => t.index === index);

      if (!found || !found.id) {
        return {
          id: command.id,
          success: false,
          error: `No tab found at index ${index} (total tabs: ${tabs.length})`,
        };
      }

      targetTab = found;
    } else {
      // 关闭当前活动标签页
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab || !activeTab.id) {
        return {
          id: command.id,
          success: false,
          error: 'No active tab found',
        };
      }

      targetTab = activeTab;
    }

    const tabId = targetTab.id!;
    const title = targetTab.title || '';
    const url = targetTab.url || '';

    await chrome.tabs.remove(tabId);

    // 清理 tab 相关状态
    cleanupDomTab(tabId);
    cleanupCdpTab(tabId);
    tabActiveFrameId.delete(tabId);

    return {
      id: command.id,
      success: true,
      data: {
        tabId,
        title,
        url,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Tab close failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Tab close failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 frame 命令 - 切换到指定 iframe
 */
async function handleFrame(command: CommandEvent): Promise<CommandResult> {
  const selector = command.selector as string;

  if (!selector) {
    return {
      id: command.id,
      success: false,
      error: 'Missing selector parameter',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;

  console.log('[CommandHandler] Switching to frame:', selector);

  try {
    // 1. 在页面中找到 iframe 元素并获取其信息
    const iframeInfoResults = await chrome.scripting.executeScript({
      target: { tabId, frameIds: tabActiveFrameId.get(tabId) !== null && tabActiveFrameId.get(tabId) !== undefined ? [tabActiveFrameId.get(tabId)!] : [0] },
      func: (sel: string) => {
        const iframe = document.querySelector(sel) as HTMLIFrameElement | null;
        if (!iframe) {
          return { found: false, error: `找不到 iframe: ${sel}` };
        }
        if (iframe.tagName.toLowerCase() !== 'iframe' && iframe.tagName.toLowerCase() !== 'frame') {
          return { found: false, error: `元素不是 iframe: ${iframe.tagName}` };
        }
        return {
          found: true,
          name: iframe.name || '',
          src: iframe.src || '',
          // 获取 iframe 在页面中的位置用于匹配
          rect: iframe.getBoundingClientRect(),
        };
      },
      args: [selector],
    });

    const iframeInfo = iframeInfoResults[0]?.result as {
      found: boolean;
      error?: string;
      name?: string;
      src?: string;
      rect?: DOMRect;
    };

    if (!iframeInfo || !iframeInfo.found) {
      return {
        id: command.id,
        success: false,
        error: iframeInfo?.error || `找不到 iframe: ${selector}`,
      };
    }

    // 2. 获取所有 frames
    const frames = await chrome.webNavigation.getAllFrames({ tabId });

    if (!frames || frames.length === 0) {
      return {
        id: command.id,
        success: false,
        error: '无法获取页面 frames',
      };
    }

    // 3. 尝试通过 URL 或 name 匹配 frameId
    let targetFrameId: number | null = null;

    // 首先尝试通过 src URL 匹配
    if (iframeInfo.src) {
      const matchedFrame = frames.find(f => 
        f.url === iframeInfo.src || 
        f.url.includes(iframeInfo.src!) ||
        iframeInfo.src!.includes(f.url)
      );
      if (matchedFrame) {
        targetFrameId = matchedFrame.frameId;
      }
    }

    // 如果没有匹配到，尝试通过非主 frame 排除
    if (targetFrameId === null) {
      // 获取非主 frame 的列表（排除 frameId 为 0 的主 frame）
      const childFrames = frames.filter(f => f.frameId !== 0);
      
      if (childFrames.length === 1) {
        // 只有一个子 frame，直接使用它
        targetFrameId = childFrames[0].frameId;
      } else if (childFrames.length > 1) {
        // 多个子 frame，尝试用 name 匹配
        if (iframeInfo.name) {
          // 目前无法直接通过 name 匹配，需要更复杂的逻辑
          // 暂时使用第一个匹配 URL 的 frame
          console.log('[CommandHandler] Multiple frames found, using URL matching');
        }
        
        // 如果还是没找到，返回错误
        if (targetFrameId === null) {
          return {
            id: command.id,
            success: false,
            error: `找到多个子 frame，无法确定目标。请使用更精确的 selector 或确保 iframe 有 src 属性。`,
          };
        }
      } else {
        return {
          id: command.id,
          success: false,
          error: '页面中没有子 frame',
        };
      }
    }

    // 4. 验证 frameId 是否有效（尝试在该 frame 中执行脚本）
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [targetFrameId] },
        func: () => true,
      });
    } catch (e) {
      return {
        id: command.id,
        success: false,
        error: `无法访问 frame (frameId: ${targetFrameId})，可能是跨域 iframe`,
      };
    }

    // 5. 保存 activeFrameId 并同步到 cdp-dom-service
    tabActiveFrameId.set(tabId, targetFrameId);
    cdpDom.setActiveFrameId(tabId, String(targetFrameId));

    const matchedFrameInfo = frames.find(f => f.frameId === targetFrameId);

    return {
      id: command.id,
      success: true,
      data: {
        frameInfo: {
          selector,
          name: iframeInfo.name,
          url: matchedFrameInfo?.url || iframeInfo.src,
          frameId: targetFrameId,
        },
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Frame switch failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Frame switch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 frame_main 命令 - 返回主 frame
 */
async function handleFrameMain(command: CommandEvent): Promise<CommandResult> {
  console.log('[CommandHandler] Switching to main frame');

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;

  // 重置 activeFrameId 并同步到 cdp-dom-service
  tabActiveFrameId.set(tabId, null);
  cdpDom.setActiveFrameId(tabId, null);

  return {
    id: command.id,
    success: true,
    data: {
      frameInfo: {
        frameId: 0,
      },
    },
  };
}

/**
 * 处理 dialog 命令 - 接受或拒绝对话框
 * v2.0: 使用 CDP Page.handleJavaScriptDialog
 */
async function handleDialog(command: CommandEvent): Promise<CommandResult> {
  const dialogResponse = command.dialogResponse as 'accept' | 'dismiss';
  const promptText = command.promptText as string | undefined;

  if (!dialogResponse || !['accept', 'dismiss'].includes(dialogResponse)) {
    return {
      id: command.id,
      success: false,
      error: 'Missing or invalid dialogResponse parameter (accept/dismiss)',
    };
  }

  // 获取目标标签页
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;

  console.log('[CommandHandler] Handling dialog:', dialogResponse, 'promptText:', promptText);

  try {
    // v2.0: 使用 CDP Service
    const pendingDialog = cdp.getPendingDialog(tabId);

    if (!pendingDialog) {
      return {
        id: command.id,
        success: false,
        error: '没有待处理的对话框',
      };
    }

    // 处理 dialog
    await cdp.handleJavaScriptDialog(
      tabId,
      dialogResponse === 'accept',
      dialogResponse === 'accept' ? promptText : undefined
    );

    // 获取 dialog 信息
    const dialogInfo = {
      type: pendingDialog.type,
      message: pendingDialog.message,
      handled: true,
    };

    return {
      id: command.id,
      success: true,
      data: {
        dialogInfo,
      },
    };
  } catch (error) {
    console.error('[CommandHandler] Dialog handling failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Dialog failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 等待标签页加载完成
 */
function waitForTabLoad(tabId: number, timeout = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeout);

    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ============================================================================
// Network/Console/Errors 命令处理
// ============================================================================

/**
 * 处理 network 命令 - 网络监控和拦截
 */
async function handleNetwork(command: CommandEvent): Promise<CommandResult> {
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;
  const subCommand = command.networkCommand as string;
  const urlPattern = command.url as string | undefined;

  console.log('[CommandHandler] Network command:', subCommand, urlPattern);

  try {
    switch (subCommand) {
      case 'requests': {
        // 确保网络监控已启用
        await cdp.enableNetwork(tabId);
        const filter = command.filter as string | undefined;
        const withBody = command.withBody === true;
        const requests = cdp.getNetworkRequests(tabId, filter, withBody);
        
        const networkRequests = requests.map(r => ({
          requestId: r.requestId,
          url: r.url,
          method: r.method,
          type: r.type,
          timestamp: r.timestamp,
          status: r.response?.status,
          statusText: r.response?.statusText,
          failed: r.failed,
          failureReason: r.failureReason,
          ...(withBody ? {
            requestHeaders: r.requestHeaders,
            requestBody: r.requestBody,
            requestBodyTruncated: r.requestBodyTruncated,
            responseHeaders: r.response?.headers,
            responseBody: r.response?.body,
            responseBodyBase64: r.response?.bodyBase64,
            responseBodyTruncated: r.response?.bodyTruncated,
            mimeType: r.response?.mimeType,
            bodyError: r.bodyError,
          } : {}),
        }));

        return {
          id: command.id,
          success: true,
          data: {
            networkRequests,
          },
        };
      }

      case 'route': {
        if (!urlPattern) {
          return {
            id: command.id,
            success: false,
            error: 'URL pattern required for route command',
          };
        }
        
        const options = command.routeOptions || {};
        await cdp.addNetworkRoute(tabId, urlPattern, options);
        const routeCount = cdp.getNetworkRoutes(tabId).length;

        return {
          id: command.id,
          success: true,
          data: {
            routeCount,
          },
        };
      }

      case 'unroute': {
        cdp.removeNetworkRoute(tabId, urlPattern);
        const routeCount = cdp.getNetworkRoutes(tabId).length;

        return {
          id: command.id,
          success: true,
          data: {
            routeCount,
          },
        };
      }

      case 'clear': {
        cdp.clearNetworkRequests(tabId);
        return {
          id: command.id,
          success: true,
          data: {},
        };
      }

      default:
        return {
          id: command.id,
          success: false,
          error: `Unknown network subcommand: ${subCommand}`,
        };
    }
  } catch (error) {
    console.error('[CommandHandler] Network command failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Network command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 console 命令 - 控制台消息
 */
async function handleConsole(command: CommandEvent): Promise<CommandResult> {
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;
  const subCommand = (command.consoleCommand || 'get') as string;

  console.log('[CommandHandler] Console command:', subCommand);

  try {
    // 确保 console 监控已启用
    await cdp.enableConsole(tabId);

    switch (subCommand) {
      case 'get': {
        const messages = cdp.getConsoleMessages(tabId);
        return {
          id: command.id,
          success: true,
          data: {
            consoleMessages: messages,
          },
        };
      }

      case 'clear': {
        cdp.clearConsoleMessages(tabId);
        return {
          id: command.id,
          success: true,
          data: {},
        };
      }

      default:
        return {
          id: command.id,
          success: false,
          error: `Unknown console subcommand: ${subCommand}`,
        };
    }
  } catch (error) {
    console.error('[CommandHandler] Console command failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Console command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 errors 命令 - JS 错误
 */
async function handleErrors(command: CommandEvent): Promise<CommandResult> {
  const activeTab = await resolveTab(command);

  if (!activeTab.id) {
    return {
      id: command.id,
      success: false,
      error: 'No active tab found',
    };
  }

  const tabId = activeTab.id;
  const subCommand = (command.errorsCommand || 'get') as string;

  console.log('[CommandHandler] Errors command:', subCommand);

  try {
    // 确保 console 监控已启用（errors 也通过 Runtime 捕获）
    await cdp.enableConsole(tabId);

    switch (subCommand) {
      case 'get': {
        const errors = cdp.getJSErrors(tabId);
        return {
          id: command.id,
          success: true,
          data: {
            jsErrors: errors,
          },
        };
      }

      case 'clear': {
        cdp.clearJSErrors(tabId);
        return {
          id: command.id,
          success: true,
          data: {},
        };
      }

      default:
        return {
          id: command.id,
          success: false,
          error: `Unknown errors subcommand: ${subCommand}`,
        };
    }
  } catch (error) {
    console.error('[CommandHandler] Errors command failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Errors command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 处理 trace 命令 - 录制用户操作
 */
async function handleTrace(command: CommandEvent): Promise<CommandResult> {
  const subCommand = (command.traceCommand || 'status') as string;

  console.log('[CommandHandler] Trace command:', subCommand);

  try {
    switch (subCommand) {
      case 'start': {
        // 获取目标标签页
        const activeTab = await resolveTab(command);

        if (!activeTab.id) {
          return {
            id: command.id,
            success: false,
            error: 'No active tab found',
          };
        }

        // 检查是否是特殊页面
        const url = activeTab.url || '';
        if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
          return {
            id: command.id,
            success: false,
            error: `Cannot record on restricted page: ${url}`,
          };
        }

        // 开始录制
        await traceService.startRecording(activeTab.id);
        const status = traceService.getStatus();

        return {
          id: command.id,
          success: true,
          data: {
            traceStatus: status,
          },
        };
      }

      case 'stop': {
        // 停止录制并获取事件
        const events = await traceService.stopRecording();

        return {
          id: command.id,
          success: true,
          data: {
            traceEvents: events,
            traceStatus: {
              recording: false,
              eventCount: events.length,
            },
          },
        };
      }

      case 'status': {
        const status = traceService.getStatus();

        return {
          id: command.id,
          success: true,
          data: {
            traceStatus: status,
          },
        };
      }

      default:
        return {
          id: command.id,
          success: false,
          error: `Unknown trace subcommand: ${subCommand}`,
        };
    }
  } catch (error) {
    console.error('[CommandHandler] Trace command failed:', error);
    return {
      id: command.id,
      success: false,
      error: `Trace command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleHistory(command: CommandEvent): Promise<CommandResult> {
  const subCommand = (command.historyCommand || 'search') as string;
  const days = typeof command.ms === 'number' && command.ms > 0 ? command.ms : 30;
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

  console.log('[CommandHandler] History command:', subCommand, 'days:', days);

  try {
    switch (subCommand) {
      case 'search': {
        const items = await chrome.history.search({
          text: command.text || '',
          maxResults: command.maxResults || 100,
          startTime,
        });

        return {
          id: command.id,
          success: true,
          data: {
            historyItems: items.map((item) => ({
              url: item.url || '',
              title: item.title || '',
              visitCount: item.visitCount || 0,
              lastVisitTime: item.lastVisitTime || 0,
            })),
          },
        };
      }

      case 'domains': {
        const items = await chrome.history.search({
          text: '',
          maxResults: 5000,
          startTime,
        });

        const domainMap = new Map<string, { visits: number; titles: Set<string> }>();

        for (const item of items) {
          if (!item.url) continue;

          let domain: string;
          try {
            domain = new URL(item.url).hostname;
          } catch {
            continue;
          }

          const current = domainMap.get(domain) || { visits: 0, titles: new Set<string>() };
          current.visits += item.visitCount || 0;
          if (item.title) {
            current.titles.add(item.title);
          }
          domainMap.set(domain, current);
        }

        const historyDomains = Array.from(domainMap.entries())
          .map(([domain, value]) => ({
            domain,
            visits: value.visits,
            titles: Array.from(value.titles),
          }))
          .sort((a, b) => b.visits - a.visits);

        return {
          id: command.id,
          success: true,
          data: {
            historyDomains,
          },
        };
      }

      default:
        return {
          id: command.id,
          success: false,
          error: `Unknown history subcommand: ${subCommand}`,
        };
    }
  } catch (error) {
    console.error('[CommandHandler] History command failed:', error);
    return {
      id: command.id,
      success: false,
      error: `History command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
