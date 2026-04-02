/**
 * Client — routes all commands through the daemon HTTP API
 */

import type { Request, Response } from "@bb-browser/shared";
import { applyJq } from "./jq.js";
import { daemonCommand, ensureDaemon } from "./daemon-manager.js";

let jqExpression: string | undefined;

export function setJqExpression(expression?: string): void {
  jqExpression = expression;
}

function printJqResults(response: Response): never {
  const target = response.data ?? response;
  const results = applyJq(target, jqExpression || ".");
  for (const result of results) {
    console.log(typeof result === "string" ? result : JSON.stringify(result));
  }
  process.exit(0);
}

export function handleJqResponse(response: Response): void {
  if (jqExpression) {
    printJqResults(response);
  }
}

export async function sendCommand(request: Request): Promise<Response> {
  await ensureDaemon();
  return daemonCommand(request);
}
