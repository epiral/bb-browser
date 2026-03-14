import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "packages/cli/src/index.ts",
    daemon: "packages/daemon/src/index.ts",
    mcp: "packages/mcp/src/index.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node18",
  splitting: true,  // 共享代码会被提取到 chunk
  outDir: "dist",
  banner: {
    js: "#!/usr/bin/env node",
  },
  // 内部包打包进去
  noExternal: [/@bb-browser\/.*/],
  // ws 使用 CommonJS 动态 require，必须保持外部依赖
  external: ["ws"],
});
