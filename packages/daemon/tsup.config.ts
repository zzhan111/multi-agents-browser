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
  // All CJS deps stay external because tsup cannot shim every require into
  // the ESM output (yaml's "Dynamic require of process"). Node's native
  // ESM-CJS interop handles them at runtime exactly as in dev, PROVIDED the
  // deployed daemon ships a hoisted node_modules (npm layout — package-win.mjs
  // generates it in the staging dir via `npm install --omit=dev`).
  external: ["ws", "chokidar", "yaml", "better-sqlite3"],
  // Bundle the workspace packages and zod (their transitive dep) so the
  // daemon is self-contained when deployed outside the monorepo (next to the
  // tray exe). @ma-browser/vault is imported by indexer/schema at runtime;
  // without bundling it the deployed daemon dies with ERR_MODULE_NOT_FOUND.
  // Everything except `ws` ends up in the single output file.
  noExternal: ["@ma-browser/shared", "@ma-browser/vault", "zod", "yaml", "chokidar", "readdirp"],
  // Bundle the workspace packages and zod (their transitive dep) so the
  // daemon is self-contained when deployed outside the monorepo (next to the
  // tray exe). @ma-browser/vault is imported by indexer/schema at runtime;
  // without bundling it the deployed daemon dies with ERR_MODULE_NOT_FOUND.
  // Everything except `ws` ends up in the single output file.
  // Workspace packages + zod (pure ESM-consumable) are inlined so most of
  // the daemon is self-contained. CJS deps that tsup cannot shim into ESM
  // (ws / chokidar / yaml / better-sqlite3) are shipped as real node_modules
  // next to the deployed daemon — package-win.mjs stages the whole
  // packages/daemon/node_modules tree (prebuilds included).
  noExternal: ["@ma-browser/shared", "@ma-browser/vault", "zod"],
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
