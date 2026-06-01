/**
 * bb-browser-clip — IPC v2 NDJSON clip entry.
 *
 * Spawned by an IPC clip host as `bun run <main> --ipc`, cwd = clip dir.
 * The host acts as the provider; this process implements only the clip side,
 * speaking the stdin/stdout NDJSON protocol — no Hub connection, no auth.
 *
 * Protocol (Pinix-compatible IPC v2 NDJSON over stdio):
 *   1. On startup, immediately send `register` with the command manifest.
 *   2. Host replies `registered` (handshake complete).
 *   3. Host sends `invoke` { id, command, input }; reply with the SAME id as
 *      `result` (success) or `error` (application failure).
 *
 * Transport rules:
 *   - stdout carries ONLY protocol JSON (one JSON object per line). All logs go
 *     to stderr — the host re-emits them as `[clip:<name>] ...`.
 *   - invoke handling does NOT block the read loop (concurrent invokes allowed).
 *   - application error -> `error` message (message surfaced to caller).
 *   - internal error    -> crash the process (the host cold-restarts us).
 *   - stdin closed by the host -> exit (otherwise the bb-browser daemon's
 *     HTTP keep-alive could pin this process open).
 */

import { createInterface } from "node:readline";
import {
  CommandFailedError,
  BROWSER_COMMANDS,
  buildPlatformClips,
  executeBrowserCommand,
  executeSiteCommand,
  zodToJsonSchema,
  type InputObject,
} from "./clip-core.ts";

// No @types/node in this project (see bb-browser-provider.ts) — declare the
// process surface we use. stdin is typed loosely; readline accepts it as-is.
declare const process: {
  argv: string[];
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
  stdin: any;
  stdout: { write(chunk: string): boolean };
};

// ---------------------------------------------------------------------------
// IPC message shape (subset we read/write)
// ---------------------------------------------------------------------------

interface IpcMessage {
  id?: string;
  type: string;
  command?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  manifest?: unknown;
}

const LOG_PREFIX = "[bb-browser-clip]";
const SITE_PREFIX = "site.";
/** JSON Schema string for command outputs (daemon responses are open objects). */
const OUTPUT_SCHEMA = JSON.stringify({ type: "object", additionalProperties: true });

function logClip(message: string): void {
  console.error(`${LOG_PREFIX} ${message}`);
}

function send(msg: IpcMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ---------------------------------------------------------------------------
// register manifest
// ---------------------------------------------------------------------------

interface CommandManifestEntry {
  name: string;
  description: string;
  input: string;
  output: string;
}

/**
 * Build the IPC command manifest: all core browser commands plus every site
 * adapter command namespaced as `site.<platform>.<command>` (one IPC clip can
 * only register a single command set, so the per-site Hub clips are merged).
 *
 * view.* (WebRTC remote viewing) is intentionally omitted — it depends on the
 * viewer sidecar + TURN, which has no IPC story yet.
 */
function buildCommandManifest(): {
  commands: CommandManifestEntry[];
  browserCount: number;
  siteCount: number;
  platformCount: number;
} {
  const browserCommands: CommandManifestEntry[] = BROWSER_COMMANDS.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    input: JSON.stringify(zodToJsonSchema(cmd.args)),
    output: OUTPUT_SCHEMA,
  }));

  const platformClips = buildPlatformClips();
  const siteCommands: CommandManifestEntry[] = platformClips.flatMap((pc) =>
    pc.commands.map((c) => ({
      name: `${SITE_PREFIX}${pc.alias}.${c.name}`,
      description: c.description,
      input: c.inputSchema,
      output: OUTPUT_SCHEMA,
    })),
  );

  return {
    commands: [...browserCommands, ...siteCommands],
    browserCount: browserCommands.length,
    siteCount: siteCommands.length,
    platformCount: platformClips.length,
  };
}

/**
 * Split a `site.<platform>.<command>` name back into its parts.
 * <command> may itself contain "." or "/"; <platform> (a top-level site dir
 * name) never contains ".", so we split on the first dot after the prefix.
 */
function parseSiteCommand(command: string): { platform: string; cmd: string } | null {
  const rest = command.slice(SITE_PREFIX.length); // "<platform>.<command>"
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1) return null;
  return { platform: rest.slice(0, dot), cmd: rest.slice(dot + 1) };
}

// ---------------------------------------------------------------------------
// invoke routing
// ---------------------------------------------------------------------------

/**
 * Run one invoke and reply with the same id. NEVER awaited by the read loop —
 * concurrent invokes must not head-of-line block each other on the shared
 * browser. Application errors are sent as `error`; internal errors re-throw and
 * become an unhandledRejection (-> deterministic crash -> host cold-restart).
 */
async function handleInvoke(msg: IpcMessage): Promise<void> {
  const input = (msg.input ?? {}) as InputObject;
  const command = msg.command ?? "";
  try {
    let result: unknown;
    if (command.startsWith(SITE_PREFIX)) {
      const parsed = parseSiteCommand(command);
      if (!parsed) throw new CommandFailedError(`Invalid site command: ${command}`);
      result = await executeSiteCommand(parsed.platform, parsed.cmd, input);
    } else {
      result = await executeBrowserCommand(command, input);
    }
    send({ id: msg.id, type: "result", output: result });
  } catch (err) {
    if (err instanceof CommandFailedError) {
      // Application error — safe to surface to the caller.
      send({ id: msg.id, type: "error", error: err.message });
    } else {
      // Internal error (daemon won't start, HTTP/CDP transport down, unexpected
      // throw) — re-throw so the process crashes and the host cold-restarts.
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  // Internal errors must crash deterministically so the host cold-restarts us
  // (and the in-flight request is reported as internal, not leaked as `error`).
  process.on("unhandledRejection", (reason: unknown) => {
    logClip(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
    process.exit(1);
  });
  process.on("uncaughtException", (err: unknown) => {
    logClip(`uncaughtException: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });

  // Step 1: register FIRST, before any heavy work (the host SIGKILLs us if no
  // register arrives within 10s). The bb-browser daemon is started lazily on the
  // first executeBrowserCommand, never before register.
  const { commands, browserCount, siteCount, platformCount } = buildCommandManifest();
  send({ type: "register", manifest: { commands } });
  logClip(
    `registered ${commands.length} commands (${browserCount} browser, ${siteCount} site across ${platformCount} platforms); view.* skipped (needs viewer sidecar + TURN)`,
  );

  // Step 2: read loop. Dispatch only — handlers are fire-and-forget so a slow
  // invoke never blocks the next one.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: IpcMessage;
    try {
      msg = JSON.parse(trimmed) as IpcMessage;
    } catch {
      logClip("failed to parse NDJSON line, skipping");
      return;
    }
    if (!msg.type) return;
    if (msg.type === "registered") return; // handshake ack — nothing to do
    if (msg.type === "invoke") {
      void handleInvoke(msg); // do NOT await — keep the loop free for concurrency
      return;
    }
    // Any other message type (heartbeat, list_clips, ...) is ignored.
  });

  rl.on("close", () => {
    // stdin closed by the host = shutdown signal. Exit actively; the
    // bb-browser daemon's HTTP keep-alive could otherwise pin us open.
    process.exit(0);
  });
}

main();
