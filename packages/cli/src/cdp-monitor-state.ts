/**
 * MonitorState — reusable monitoring state for CDP events.
 *
 * Extracted from the event‐handling logic in cdp-client.ts so that the
 * long‐running monitor process can accumulate network, console, error
 * and trace data across multiple short‐lived CLI invocations.
 */

import type {
  NetworkRequestInfo,
  ConsoleMessageInfo,
  JSErrorInfo,
  TraceEvent,
} from "@bb-browser/shared";

type JsonObject = Record<string, unknown>;

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

export class MonitorState {
  networkRequests = new Map<string, NetworkRequestInfo>();
  networkEnabled = false;

  consoleMessages: ConsoleMessageInfo[] = [];
  consoleEnabled = false;

  jsErrors: JSErrorInfo[] = [];
  errorsEnabled = false;

  traceRecording = false;
  traceEvents: TraceEvent[] = [];

  /**
   * Feed a CDP session event (from any attached target) into the monitor
   * state.  The method + params mirror what cdp-client.ts handles inside
   * its own handleSessionEvent, but without any connection‐specific logic
   * (dialog handling, etc.) that the monitor does not need.
   */
  handleSessionEvent(method: string, params: JsonObject): void {
    if (method === "Network.requestWillBeSent") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const request = params.request as JsonObject | undefined;
      if (!requestId || !request) return;
      this.networkRequests.set(requestId, {
        requestId,
        url: String(request.url ?? ""),
        method: String(request.method ?? "GET"),
        type: String(params.type ?? "Other"),
        timestamp: Math.round(Number(params.timestamp ?? Date.now()) * 1000),
        requestHeaders: normalizeHeaders(request.headers),
        requestBody: typeof request.postData === "string" ? request.postData : undefined,
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const response = params.response as JsonObject | undefined;
      if (!requestId || !response) return;
      const existing = this.networkRequests.get(requestId);
      if (!existing) return;
      existing.status = typeof response.status === "number" ? response.status : undefined;
      existing.statusText = typeof response.statusText === "string" ? response.statusText : undefined;
      existing.responseHeaders = normalizeHeaders(response.headers);
      existing.mimeType = typeof response.mimeType === "string" ? response.mimeType : undefined;
      this.networkRequests.set(requestId, existing);
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      if (!requestId) return;
      const existing = this.networkRequests.get(requestId);
      if (!existing) return;
      existing.failed = true;
      existing.failureReason = typeof params.errorText === "string" ? params.errorText : "Unknown error";
      this.networkRequests.set(requestId, existing);
      return;
    }

    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type ?? "log");
      const args = Array.isArray(params.args) ? (params.args as JsonObject[]) : [];
      const text = args
        .map((arg) => {
          if (typeof arg.value === "string") return arg.value;
          if (arg.value !== undefined) return String(arg.value);
          if (typeof arg.description === "string") return arg.description;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      const stack = params.stackTrace as JsonObject | undefined;
      const firstCallFrame = Array.isArray(stack?.callFrames)
        ? (stack?.callFrames[0] as JsonObject | undefined)
        : undefined;
      this.consoleMessages.push({
        type: ["log", "info", "warn", "error", "debug"].includes(type)
          ? (type as ConsoleMessageInfo["type"])
          : "log",
        text,
        timestamp: Math.round(Number(params.timestamp ?? Date.now())),
        url: typeof firstCallFrame?.url === "string" ? firstCallFrame.url : undefined,
        lineNumber: typeof firstCallFrame?.lineNumber === "number" ? firstCallFrame.lineNumber : undefined,
      });
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as JsonObject | undefined;
      if (!details) return;
      const exception = details.exception as JsonObject | undefined;
      const stackTrace = details.stackTrace as JsonObject | undefined;
      const callFrames = Array.isArray(stackTrace?.callFrames)
        ? (stackTrace.callFrames as JsonObject[])
        : [];
      this.jsErrors.push({
        message:
          typeof exception?.description === "string"
            ? exception.description
            : String(details.text ?? "JavaScript exception"),
        url:
          typeof details.url === "string"
            ? details.url
            : typeof callFrames[0]?.url === "string"
              ? String(callFrames[0].url)
              : undefined,
        lineNumber: typeof details.lineNumber === "number" ? details.lineNumber : undefined,
        columnNumber: typeof details.columnNumber === "number" ? details.columnNumber : undefined,
        stackTrace:
          callFrames.length > 0
            ? callFrames
                .map(
                  (frame) =>
                    `${String(frame.functionName ?? "<anonymous>")} (${String(frame.url ?? "")}:${String(frame.lineNumber ?? 0)}:${String(frame.columnNumber ?? 0)})`,
                )
                .join("\n")
            : undefined,
        timestamp: Date.now(),
      });
    }
  }

  // --------------- clear helpers ---------------

  clearNetwork(): void {
    this.networkRequests.clear();
  }

  clearConsole(): void {
    this.consoleMessages.length = 0;
  }

  clearErrors(): void {
    this.jsErrors.length = 0;
  }

  // --------------- query helpers ---------------

  getNetworkRequests(filter?: string): NetworkRequestInfo[] {
    const all = Array.from(this.networkRequests.values());
    if (!filter) return all;
    return all.filter((item) => item.url.includes(filter));
  }

  getConsoleMessages(filter?: string): ConsoleMessageInfo[] {
    if (!filter) return this.consoleMessages;
    return this.consoleMessages.filter((item) => item.text.includes(filter));
  }

  getJsErrors(filter?: string): JSErrorInfo[] {
    if (!filter) return this.jsErrors;
    return this.jsErrors.filter(
      (item) => item.message.includes(filter) || item.url?.includes(filter),
    );
  }
}
