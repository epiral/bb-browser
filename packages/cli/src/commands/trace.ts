/**
 * trace 命令 - 录制用户操作
 * 
 * 用法：
 *   bb-browser trace start   开始录制
 *   bb-browser trace stop    停止录制，输出事件列表
 *   bb-browser trace status  查看录制状态
 */

import { generateId } from "@bb-browser/shared";
import { sendCommand } from "../client.js";

interface TraceOptions {
  json?: boolean;
  tabId?: string | number;
}

export async function traceCommand(
  subCommand: 'start' | 'stop' | 'status',
  options: TraceOptions = {}
): Promise<void> {
  const response = await sendCommand({
    id: generateId(),
    action: "trace",
    traceCommand: subCommand,
    tabId: options.tabId,
  });

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (!response.success) {
    throw new Error(response.error || "Trace command failed");
  }

  const data = response.data;

  switch (subCommand) {
    case "start": {
      const status = data?.traceStatus;
      console.log("开始录制用户操作");
      console.log(`标签页 ID: ${status?.tabId || 'N/A'}`);
      console.log("\n在浏览器中进行操作，完成后运行 'bb-browser trace stop' 停止录制");
      break;
    }

    case "stop": {
      const events = data?.traceEvents || [];
      const status = data?.traceStatus;
      
      console.log(`录制完成，共 ${events.length} 个事件\n`);
      
      if (events.length === 0) {
        console.log("没有录制到任何操作");
        break;
      }
      
      // 输出事件列表
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const refStr = event.ref !== undefined ? `@${event.ref}` : '';
        
        switch (event.type) {
          case 'navigation':
            console.log(`${i + 1}. 导航到: ${event.url}`);
            break;
          case 'click':
            console.log(`${i + 1}. 点击 ${refStr} [${event.elementRole}] "${event.elementName || ''}"`);
            break;
          case 'fill':
            console.log(`${i + 1}. 填充 ${refStr} [${event.elementRole}] "${event.elementName || ''}" <- "${event.value}"`);
            break;
          case 'select':
            console.log(`${i + 1}. 选择 ${refStr} [${event.elementRole}] "${event.elementName || ''}" <- "${event.value}"`);
            break;
          case 'check':
            console.log(`${i + 1}. ${event.checked ? '勾选' : '取消勾选'} ${refStr} [${event.elementRole}] "${event.elementName || ''}"`);
            break;
          case 'press':
            console.log(`${i + 1}. 按键 ${event.key}`);
            break;
          case 'scroll':
            console.log(`${i + 1}. 滚动 ${event.direction} ${event.pixels}px`);
            break;
          default:
            console.log(`${i + 1}. ${event.type}`);
        }
      }
      
      console.log(`\n状态: ${status?.recording ? '录制中' : '已停止'}`);
      break;
    }

    case "status": {
      const status = data?.traceStatus;
      if (status?.recording) {
        console.log(`录制中 (标签页 ${status.tabId})`);
        console.log(`已录制 ${status.eventCount} 个事件`);
      } else {
        console.log("未在录制");
      }
      break;
    }

    default:
      throw new Error(`未知的 trace 子命令: ${subCommand}`);
  }
}
