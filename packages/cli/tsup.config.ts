import { defineConfig } from "tsup";

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
  // Node.js built-in modules must be external so they are imported as ESM,
  // not bundled via __require() which fails in ESM context.
  external: ["ws", "node:fs", "fs", "node:path", "path", "node:os", "os", "node:child_process", "child_process"],
  noExternal: [],
});
