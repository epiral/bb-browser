import { defineConfig } from "tsup";
import { copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
  // `ws` is a CommonJS module that cannot be bundled into an ESM output
  // (its internal `require("events")` becomes an unsupported dynamic
  // require). Keep it external and ship it as node_modules next to the
  // deployed daemon.
  external: ["ws"],
  // Bundle the workspace package and zod (its transitive dep) so the daemon
  // is self-contained when deployed outside the monorepo (next to the tray
  // exe). Everything except `ws` ends up in the single output file.
  noExternal: ["@bb-browser/shared", "zod"],
  // Copy buildDomTree.js alongside the bundle so it is discoverable at
  // runtime both in the monorepo and in a deployed tray installation.
  async onSuccess() {
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = resolve(dir, "../shared/buildDomTree.js");
    const dst = resolve(dir, "dist/buildDomTree.js");
    copyFileSync(src, dst);
    console.log("[tsup] copied buildDomTree.js → dist/");
  },
});
