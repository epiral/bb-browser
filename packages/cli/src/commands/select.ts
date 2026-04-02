/**
 * select 命令 - 在下拉框中选择选项
 * 用法：bb-browser select <ref> <value>
 * 
 * ref 支持格式：
 *   - "@5" 或 "5"：使用 snapshot 返回的 ref ID
 * 
 * value：选项的 value 属性值或显示文本（label）
 */

import { generateId, type Request, type Response } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface SelectOptions {
  json?: boolean;
  tabId?: string | number;
}

/**
 * 解析 ref 参数，支持 "@5" 或 "5" 格式
 */
function parseRef(ref: string): string {
  // 移除 @ 前缀（如果有）
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

export async function selectCommand(
  ref: string,
  value: string,
  options: SelectOptions = {}
): Promise<void> {
  // 验证参数
  if (!ref) {
    throw new Error("缺少 ref 参数");
  }

  if (value === undefined || value === null) {
    throw new Error("缺少 value 参数");
  }

  // 确保 Daemon 运行
  await ensureDaemonRunning();

  // 解析 ref
  const parsedRef = parseRef(ref);

  // 构造请求
  const request: Request = {
    id: generateId(),
    action: "select",
    ref: parsedRef,
    value: value,
    tabId: options.tabId,
  };

  // 发送请求
  const response: Response = await sendCommand(request);

  // 输出结果
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    if (response.success) {
      const role = response.data?.role ?? "combobox";
      const name = response.data?.name;
      const selectedValue = response.data?.selectedValue;
      const selectedLabel = response.data?.selectedLabel;
      if (name) {
        console.log(`已选择: ${role} "${name}"`);
      } else {
        console.log(`已选择: ${role}`);
      }
      if (selectedLabel && selectedLabel !== selectedValue) {
        console.log(`选项: "${selectedLabel}" (value="${selectedValue}")`);
      } else {
        console.log(`选项: "${selectedValue}"`);
      }
    } else {
      console.error(`错误: ${response.error}`);
      process.exit(1);
    }
  }
}
