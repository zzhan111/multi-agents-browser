import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    cli: "packages/cli/src/index.ts",
    daemon: "packages/daemon/src/index.ts",
    mcp: "packages/mcp/src/index.ts",
    provider: "bin/ma-browser-provider.ts",
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
  // Bundle everything for npx except CJS/native deps that esbuild cannot
  // rewrite into ESM. yaml@2.x does `require("process")` in composer.js;
  // better-sqlite3 does `require("fs")` — inlining either throws
  // `Dynamic require of "..." is not supported` (issue #15).
  // Same set as packages/daemon/tsup.config.ts (minus chokidar, which is ESM).
  noExternal: [/^(?!ws$|yaml$|better-sqlite3$).*/],
  external: ["ws", "yaml", "better-sqlite3"],
});
