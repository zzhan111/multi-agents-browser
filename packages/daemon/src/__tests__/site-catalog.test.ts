import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterAdaptersForScope,
  queryCatalog,
  type SiteAdapter,
} from "../site-catalog.js";

function adapter(name: string, readOnly?: boolean): SiteAdapter {
  return {
    name,
    description: `${name} adapter`,
    domain: `${name}.example.com`,
    args: {},
    readOnly,
    source: "local",
    filePath: `${name}.js`,
  };
}

describe("site catalog discovery", () => {
  it("reorders filtered results by recent call heat while keeping ties stable", () => {
    const adapters = [adapter("alpha"), adapter("beta"), adapter("gamma")];
    const results = queryCatalog(adapters, {
      q: "adapter",
      recentCallHeat: new Map([
        ["gamma", 2],
        ["beta", 8],
      ]),
    });

    assert.deepEqual(results.map((item) => item.name), ["beta", "gamma", "alpha"]);
  });

  it("hides only explicit write adapters from read-only discovery", () => {
    const adapters = [adapter("read", true), adapter("write", false), adapter("unknown")];

    assert.deepEqual(
      filterAdaptersForScope(adapters, true).map((item) => item.name),
      ["read", "unknown"],
    );
    assert.equal(filterAdaptersForScope(adapters, false).length, 3);
  });
});
