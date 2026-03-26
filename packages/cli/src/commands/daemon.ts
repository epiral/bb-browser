import { spawn } from "node:child_process";
import { getDaemonPath, isDaemonRunning } from "../daemon-manager.js";

export interface DaemonOptions {
  json?: boolean;
  host?: string;
}

export async function daemonCommand(args: string[]): Promise<void> {
  await new Promise<void>((_resolve, reject) => {
    const child = spawn(process.execPath, [getDaemonPath(), ...args], {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Daemon exited with signal ${signal}`));
        return;
      }
      process.exit(code ?? 0);
    });
  });
}

export async function statusCommand(
  options: DaemonOptions = {}
): Promise<void> {
  const running = await isDaemonRunning();

  if (options.json) {
    console.log(JSON.stringify({ running }));
  } else {
    console.log(running ? "浏览器运行中" : "浏览器未运行");
  }
}
