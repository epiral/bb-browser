import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { defineConfig } from "tsup";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    cli: "packages/cli/src/index.ts",
    "cdp-monitor": "packages/cli/src/cdp-monitor.ts",
    daemon: "packages/daemon/src/index.ts",
    mcp: "packages/mcp/src/index.ts",
    provider: "bin/bb-browser-provider.ts",
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
  define: {
    __BB_BROWSER_VERSION__: JSON.stringify(packageJson.version),
  },
  // 全部 bundle 进去（npx 可用），只保留 ws（CommonJS 动态 require）
  noExternal: [/^(?!ws$).*/],
  external: ["ws"],
  esbuildPlugins: [{
    name: "resolve-hub-client-gen",
    setup(build) {
      // Allow deep import into @pinixai/hub-client/src/gen/hub_pb
      // (the package only exports "." but we need the gen file for proto schemas)
      build.onResolve({ filter: /^@pinixai\/hub-client\/src\/gen\/hub_pb$/ }, (args) => {
        let dir = args.resolveDir;
        while (dir !== "/") {
          const candidate = join(dir, "node_modules/@pinixai/hub-client/src/gen/hub_pb.ts");
          if (existsSync(candidate)) return { path: candidate };
          dir = dirname(dir);
        }
        return undefined;
      });
    },
  }],
});
