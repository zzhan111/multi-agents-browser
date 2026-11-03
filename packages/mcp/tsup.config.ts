import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  define: { __BB_BROWSER_VERSION__: JSON.stringify(version) },
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/@ma-browser\/.*/],
});
