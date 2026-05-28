/**
 * trace 命令 - 录制操作 + 网络请求的统一时间线
 */

import type { Request, TraceEntry } from "@bb-browser/shared";
import { sendCommand } from "../client.js";

interface TraceOptions {
  json?: boolean;
  tabId?: string | number;
  since?: number | string;
  type?: string;
  filter?: string;
  limit?: number;
  requestId?: string;
}

export async function traceCommand(
  subCommand: 'start' | 'stop' | 'status' | 'events' | 'body',
  options: TraceOptions = {}
): Promise<void> {
  const request: Record<string, unknown> = {
    method: "trace",
    traceCommand: subCommand,
    tabId: options.tabId,
  };

  // events-specific params
  if (subCommand === 'events') {
    if (options.since !== undefined) request.since = Number(options.since);
    if (options.type) request.traceType = options.type;
    if (options.filter) request.filter = options.filter;
    if (options.limit) request.limit = Number(options.limit);
  }

  // body-specific params
  if (subCommand === 'body') {
    request.requestId = options.requestId;
  }

  const response = await sendCommand(request as Request);

  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (response.error) {
    throw new Error(response.error.message || "Trace command failed");
  }

  const data = response.result;

  switch (subCommand) {
    case "start": {
      const status = data?.traceStatus;
      console.log("Trace started");
      if (status?.tracedTabs?.length) {
        console.log(`Tracing tabs: ${status.tracedTabs.join(', ')}`);
      }
      console.log("\nOperate the browser, then run 'bb-browser trace events' to see the timeline.");
      break;
    }

    case "stop": {
      const status = data?.traceStatus;
      console.log(`Trace stopped (${status?.eventCount ?? 0} events recorded)`);
      console.log("Data preserved — use 'trace events' to query, 'trace start' to begin a new session.");
      break;
    }

    case "status": {
      const status = data?.traceStatus;
      if (status?.recording) {
        console.log(`Recording (${status.eventCount} events)`);
        if (status.tracedTabs?.length) {
          console.log(`Tabs: ${status.tracedTabs.join(', ')}`);
        }
      } else if (status?.eventCount) {
        console.log(`Stopped (${status.eventCount} events in buffer)`);
      } else {
        console.log("No active trace session");
      }
      break;
    }

    case "events": {
      const events = (data?.traceEvents || []) as TraceEntry[];
      const cursor = (data as Record<string, unknown>)?.cursor;

      if (events.length === 0) {
        console.log("No events");
        break;
      }

      // Print timeline
      for (const e of events) {
        const tabStr = `[${e.tab}]`;
        switch (e.type) {
          case 'action': {
            const src = e.source === 'human' ? ' (human)' : '';
            const ref = e.ref !== undefined ? ` ref=${e.ref}` : '';
            const val = e.value ? ` "${e.value}"` : '';
            const key = e.key ? ` ${e.key}` : '';
            const info = e.text ? ` "${e.text}"` : '';
            const role = e.role ? ` [${e.role}]` : '';
            console.log(`  ${e.seq}  ${tabStr}  action${src}    ${e.action}${ref}${role}${info}${val}${key}`);
            break;
          }
          case 'request': {
            const trigger = e.triggerSeq ? `  trigger:${e.triggerSeq}` : '';
            const body = e.body ? ` (body: ${e.body.length}B)` : '';
            console.log(`  ${e.seq}  ${tabStr}  request      ${e.method} ${e.url}${body}${trigger}`);
            break;
          }
          case 'response': {
            const size = e.bodySize ? ` ${e.bodySize}B` : '';
            const mime = e.mimeType ? ` ${e.mimeType}` : '';
            console.log(`  ${e.seq}  ${tabStr}  response     ${e.requestId} → ${e.status}${mime}${size}`);
            break;
          }
          case 'navigation': {
            const from = e.from ? ` (from: ${e.from})` : '';
            console.log(`  ${e.seq}  ${tabStr}  navigation   ${e.url}${from}`);
            break;
          }
        }
      }

      console.log(`\n${events.length} events, cursor: ${cursor}`);
      break;
    }

    case "body": {
      const body = data?.traceBody;
      if (!body) {
        console.error("No body data returned");
        break;
      }
      if (body.base64Encoded) {
        console.log(`[base64 encoded, ${body.body.length} chars]`);
      } else {
        console.log(body.body);
      }
      break;
    }
  }
}
