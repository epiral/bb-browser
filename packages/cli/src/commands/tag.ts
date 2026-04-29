import { generateId, type Request, type Response, type TagRecord } from "@bb-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";
import { parseLocatorInput } from "../locator.js";

export interface TagCommandOptions {
  json?: boolean;
  tabId?: string | number;
}

function toTagLocator(input: string): string {
  return input.startsWith("@@") ? input : `@@${input}`;
}

function printTag(record: TagRecord): void {
  console.log(`@@${record.name} (${record.mode})`);
  console.log(`域名: ${record.domain}`);
  console.log(`元素: ${formatTagFingerprint(record)}`);
  console.log(`更新时间: ${record.updatedAt}`);
}

function formatTagFingerprint(record: TagRecord): string {
  const fp = record.fingerprint;
  const parts = [
    fp.role ? `role=${fp.role}` : undefined,
    fp.tagName ? `tag=${fp.tagName}` : undefined,
    fp.name ? `name="${trimForDisplay(fp.name)}"` : undefined,
    fp.text && fp.text !== fp.name ? `text="${trimForDisplay(fp.text)}"` : undefined,
    fp.placeholder ? `placeholder="${trimForDisplay(fp.placeholder)}"` : undefined,
    fp.id ? `id=${fp.id}` : undefined,
    fp.inputName ? `inputName=${fp.inputName}` : undefined,
    fp.classTokens && fp.classTokens.length > 0 ? `class=${fp.classTokens.join(".")}` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : "无可用指纹";
}

function trimForDisplay(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}

export async function tagSetCommand(
  tagName: string,
  ref: string,
  mode: "single" | "list",
  options: TagCommandOptions = {},
): Promise<void> {
  await ensureDaemonRunning();
  const request: Request = {
    id: generateId(),
    action: "tag_set",
    tagName,
    tagMode: mode,
    ref: parseLocatorInput(ref),
    tabId: options.tabId,
  };
  const response: Response = await sendCommand(request);
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (!response.success || !response.data?.tagInfo) {
    console.error(`错误: ${response.error ?? "保存 tag 失败"}`);
    process.exit(1);
  }
  printTag(response.data.tagInfo);
  console.log(`已保存，后续可直接使用: bb-browser click @@${tagName}`);
}

export async function tagGetCommand(
  tagName: string,
  options: TagCommandOptions = {},
): Promise<void> {
  await ensureDaemonRunning();
  const response = await sendCommand({
    id: generateId(),
    action: "tag_get",
    tagName,
    tabId: options.tabId,
  });
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (!response.success || !response.data?.tagInfo) {
    console.error(`错误: ${response.error ?? "tag 不存在"}`);
    process.exit(1);
  }
  printTag(response.data.tagInfo);
}

export async function tagListCommand(options: TagCommandOptions = {}): Promise<void> {
  await ensureDaemonRunning();
  const response = await sendCommand({
    id: generateId(),
    action: "tag_list",
    tabId: options.tabId,
  });
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (!response.success) {
    console.error(`错误: ${response.error}`);
    process.exit(1);
  }
  const tags = response.data?.tags ?? [];
  if (tags.length === 0) {
    console.log("当前域名还没有保存任何 tag");
    return;
  }
  for (const tag of tags) {
    console.log(`@@${tag.name} (${tag.mode})`);
    console.log(`  元素: ${formatTagFingerprint(tag)}`);
    console.log(`  稳定目标: "@@${tag.name}"`);
  }
}

export async function tagRemoveCommand(
  tagName: string,
  options: TagCommandOptions = {},
): Promise<void> {
  await ensureDaemonRunning();
  const response = await sendCommand({
    id: generateId(),
    action: "tag_remove",
    tagName,
    tabId: options.tabId,
  });
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (!response.success) {
    console.error(`错误: ${response.error}`);
    process.exit(1);
  }
  console.log(`已删除 tag: @@${tagName}`);
}

export async function tagResolveCommand(
  tagName: string,
  options: TagCommandOptions = {},
): Promise<void> {
  await ensureDaemonRunning();
  const response = await sendCommand({
    id: generateId(),
    action: "tag_resolve",
    tagName,
    tabId: options.tabId,
  });
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (!response.success) {
    console.error(`错误: ${response.error}`);
    process.exit(1);
  }
  const matches = response.data?.tagMatches ?? [];
  console.log(`@@${tagName} 命中 ${matches.length} 个元素`);
  for (const match of matches) {
    const label = match.name || match.text || "";
    console.log(`[${match.index}] <${match.tagName}> ${label}`.trim());
  }
}

export async function tagMatchCommand(
  tagNameOrLocator: string,
  options: TagCommandOptions = {},
): Promise<void> {
  await ensureDaemonRunning();
  const response = await sendCommand({
    id: generateId(),
    action: "match",
    ref: parseLocatorInput(toTagLocator(tagNameOrLocator)),
    tabId: options.tabId,
  });
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (!response.success) {
    console.error(`错误: ${response.error}`);
    process.exit(1);
  }
  const role = response.data?.role ?? "element";
  const name = response.data?.name;
  if (name) {
    console.log(`已高亮匹配: ${role} "${name}"`);
  } else {
    console.log(`已高亮匹配: ${role}`);
  }
}
