import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAdapterScript, loadAdapters, matchTabOrigin } from "../site-adapters.js";

function library() {
  const root = mkdtempSync(join(tmpdir(), "ma-sites-"));
  const local = join(root, "sites");
  const community = join(root, "bb-sites");
  const write = (dir: string, rel: string, content: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  write(community, "shop/search.js", `/* @meta\n{"name":"shop/search","description":"community","domain":"shop.test","args":{"q":{"required":true},"page":{}}}\n*/\nasync function(args) { return args; }`);
  write(community, "shop/hot.js", `/* @meta\n{"name":"shop/hot","domain":"shop.test"}\n*/\nasync function() { return 1; }`);
  write(community, ".git/hooks/x.js", `/* @meta\n{"name":"never","domain":"x"}\n*/\nasync function() {}`);
  write(local, "shop/search.js", `/* @meta\n{"name":"shop/search","description":"private","domain":"shop.test","args":{"q":{"required":true},"page":{}}}\n*/\nasync function(args) { return args; }`);
  write(local, "legacy/old.js", `// @domain old.test\n// @args id\nasync function(args) { return args.id; }`);
  return { root, local, community };
}

test("loadAdapters merges libraries with private adapters winning by name", () => {
  const lib = library();
  try {
    const adapters = loadAdapters(lib.local, lib.community);
    assert.deepEqual(adapters.map((a) => [a.name, a.source, a.description]), [
      ["legacy/old", "local", ""],
      ["shop/hot", "community", ""],
      ["shop/search", "local", "private"],
    ]);
    const legacy = adapters[0];
    assert.equal(legacy.domain, "old.test");
    assert.deepEqual(legacy.args, { id: { required: true } });
  } finally {
    rmSync(lib.root, { recursive: true, force: true });
  }
});

test("buildAdapterScript fills flags, named args and positionals, and reports missing ones", () => {
  const lib = library();
  try {
    const search = loadAdapters(lib.local, lib.community).find((a) => a.name === "shop/search")!;
    assert.deepEqual(buildAdapterScript(search, ["shoes", "--page", "2"]), { script: '(async function(args) { return args; })({"page":"2","q":"shoes"})' });
    assert.deepEqual(buildAdapterScript(search, ["2"], { q: "hats" }), { script: '(async function(args) { return args; })({"q":"hats","page":"2"})' });
    assert.deepEqual(buildAdapterScript(search, [""]), { error: "Missing required argument 'q' for adapter 'shop/search'", missing: "q" });
  } finally {
    rmSync(lib.root, { recursive: true, force: true });
  }
});

test("matchTabOrigin accepts the domain and its subdomains only", () => {
  assert.equal(matchTabOrigin("https://shop.test/a", "shop.test"), true);
  assert.equal(matchTabOrigin("https://m.shop.test/a", "shop.test"), true);
  assert.equal(matchTabOrigin("https://evilshop.test/a", "shop.test"), false);
  assert.equal(matchTabOrigin("not a url", "shop.test"), false);
});
