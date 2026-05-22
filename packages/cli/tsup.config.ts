import { defineConfig } from "tsup";

import { readFileSync } from "node:fs";

const version = (() => {
  try {
    return JSON.parse(readFileSync("../../package.json", "utf-8")).version;
  } catch {
    try {
      return JSON.parse(readFileSync("package.json", "utf-8")).version;
    } catch {
      return "0.0.0";
    }
  }
})();

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
  define: {
    __BB_BROWSER_VERSION__: JSON.stringify(version),
  },
  // ws 使用 Node.js 内置模块，需要标记为外部依赖
  external: ["ws"],
  noExternal: [],
});
