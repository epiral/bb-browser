import { getDaemonStatus, stopDaemon } from "../daemon-manager.js";

export interface DaemonOptions {
  json?: boolean;
}

export async function statusCommand(
  options: DaemonOptions = {}
): Promise<void> {
  const status = await getDaemonStatus();

  if (!status) {
    if (options.json) {
      console.log(JSON.stringify({ running: false }));
    } else {
      console.log("Daemon not running");
    }
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  // Human-readable output
  console.log(`Daemon running: ${status.running ? "yes" : "no"}`);
  console.log(`CDP connected:  ${status.cdpConnected ? "yes" : "no"}`);
  console.log(`Uptime:         ${formatUptime(status.uptime as number)}`);
  console.log(`Global seq:     ${status.currentSeq ?? "N/A"}`);

  const tabs = status.tabs as Array<{
    shortId: string;
    targetId: string;
    networkRequests: number;
    consoleMessages: number;
    jsErrors: number;
    lastActionSeq: number;
  }> | undefined;

  if (tabs && tabs.length > 0) {
    console.log(`\nTabs (${tabs.length}):`);
    for (const tab of tabs) {
      const active = tab.targetId === status.currentTargetId ? " *" : "";
      console.log(
        `  ${tab.shortId}${active}  net:${tab.networkRequests} console:${tab.consoleMessages} err:${tab.jsErrors} seq:${tab.lastActionSeq}`
      );
    }
  } else {
    console.log("\nNo tabs");
  }
}

export async function shutdownCommand(
  options: DaemonOptions = {}
): Promise<void> {
  const ok = await stopDaemon();
  if (options.json) {
    console.log(JSON.stringify({ stopped: ok }));
  } else {
    console.log(ok ? "Daemon stopped" : "Daemon was not running");
  }
}

function formatUptime(ms: number): string {
  if (!ms || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
