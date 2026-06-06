/**
 * StateStore — atomic JSON snapshot store backed by BB_BROWSER_HOME/state/.
 *
 * Every write is atomic: we write to a temp file in the same directory and
 * rename it over the target, so readers never observe a partial JSON file.
 * On Windows the rename may fail with EPERM when the target is open; we fall
 * back to a direct overwrite in that case (brief non-atomic window, same as
 * daemon.json's fallback in index.ts).
 *
 * Single-writer assumption: all writes go through the daemon process. No
 * concurrency control beyond the atomic rename is needed.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

export class StateStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Read a JSON file, returning null on missing/corrupt. */
  read<T>(filename: string): T | null {
    try {
      return JSON.parse(readFileSync(path.join(this.dir, filename), "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** Atomically write a JSON file (tmp → rename). */
  write<T>(filename: string, value: T): void {
    const full = path.join(this.dir, filename);
    const tmp = `${full}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    try {
      renameSync(tmp, full);
    } catch {
      // Windows cross-device / sharing-violation fallback.
      try {
        writeFileSync(full, JSON.stringify(value), { mode: 0o600 });
      } finally {
        try { unlinkSync(tmp); } catch { /* ignore */ }
      }
    }
  }
}
