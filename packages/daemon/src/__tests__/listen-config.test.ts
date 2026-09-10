/**
 * Unit tests for advertisedHost / daemon.json local vs remote writes.
 *
 * These are pure (no HTTP server, no Chrome). Lifecycle tests cover the
 * process actually writing daemon.json.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";

import {
  advertisedHost,
  buildDaemonFileInfo,
  envTruthy,
  parseListenArgs,
  resolveRemoteAccess,
} from "../listen-config.js";
import { allowCorsOrigin } from "../http-server.js";

function originReq(origin: string): IncomingMessage {
  return { headers: { origin } } as IncomingMessage;
}

describe("advertisedHost", () => {
  it("defaults to loopback when remote is off and bind is loopback", () => {
    assert.equal(advertisedHost("127.0.0.1"), "127.0.0.1");
  });

  it("rewrites wildcard bind to 127.0.0.1 when remote is off (today's behavior)", () => {
    assert.equal(advertisedHost("0.0.0.0"), "127.0.0.1");
    assert.equal(advertisedHost("::"), "127.0.0.1");
    assert.equal(advertisedHost("0.0.0.0", { remoteAccess: false }), "127.0.0.1");
  });

  it("ignores advertiseHost when remote is off", () => {
    assert.equal(
      advertisedHost("0.0.0.0", { remoteAccess: false, advertiseHost: "100.74.28.0" }),
      "127.0.0.1",
    );
  });

  it("does not rewrite wildcard bind to 127.0.0.1 when remote is on", () => {
    assert.equal(advertisedHost("0.0.0.0", { remoteAccess: true }), "0.0.0.0");
    assert.equal(advertisedHost("::", { remoteAccess: true }), "::");
  });

  it("uses the user-chosen advertiseHost when remote is on", () => {
    assert.equal(
      advertisedHost("0.0.0.0", { remoteAccess: true, advertiseHost: "100.74.28.0" }),
      "100.74.28.0",
    );
    assert.equal(
      advertisedHost("0.0.0.0", { remoteAccess: true, advertiseHost: "desktop-1point" }),
      "desktop-1point",
    );
    assert.equal(
      advertisedHost("127.0.0.1", { remoteAccess: true, advertiseHost: "100.74.28.0" }),
      "100.74.28.0",
    );
  });

  it("advertises a specific Tailscale bind as-is when remote is on and advertiseHost is unset", () => {
    assert.equal(advertisedHost("100.74.28.0", { remoteAccess: true }), "100.74.28.0");
  });
});

describe("resolveRemoteAccess", () => {
  it("is off by default (loopback bind, no flag/env)", () => {
    assert.equal(resolveRemoteAccess({ bindHost: "127.0.0.1" }), false);
  });

  it("treats wildcard bind alone as local (WSL / advanced 0.0.0.0)", () => {
    assert.equal(resolveRemoteAccess({ bindHost: "0.0.0.0" }), false);
  });

  it("turns on via --remote-access flag", () => {
    assert.equal(resolveRemoteAccess({ flag: true, bindHost: "127.0.0.1" }), true);
  });

  it("turns on via BB_REMOTE_ACCESS=1", () => {
    assert.equal(
      resolveRemoteAccess({ envValue: "1", bindHost: "127.0.0.1" }),
      true,
    );
  });

  it("flag wins over env (flag present → on even if env is 0)", () => {
    assert.equal(
      resolveRemoteAccess({ flag: true, envValue: "0", bindHost: "127.0.0.1" }),
      true,
    );
  });

  it("turns on when advertiseHost is a Tailscale IP / hostname", () => {
    assert.equal(
      resolveRemoteAccess({ bindHost: "0.0.0.0", advertiseHost: "100.74.28.0" }),
      true,
    );
    assert.equal(
      resolveRemoteAccess({ bindHost: "127.0.0.1", advertiseHost: "desktop-1point" }),
      true,
    );
  });

  it("turns on when bind is a specific non-loopback address", () => {
    assert.equal(resolveRemoteAccess({ bindHost: "100.74.28.0" }), true);
  });
});

describe("buildDaemonFileInfo (daemon.json local vs remote writes)", () => {
  it("writes loopback host and remoteAccess:false when remote is off", () => {
    const info = buildDaemonFileInfo({
      pid: 123,
      bindHost: "127.0.0.1",
      port: 19824,
      token: "tok",
      remoteAccess: false,
    });
    assert.deepEqual(info, {
      pid: 123,
      host: "127.0.0.1",
      bindHost: "127.0.0.1",
      port: 19824,
      token: "tok",
      remoteAccess: false,
    });
  });

  it("still advertises 127.0.0.1 for wildcard bind when remote is off", () => {
    const info = buildDaemonFileInfo({
      pid: 1,
      bindHost: "0.0.0.0",
      port: 19824,
      token: "tok",
      remoteAccess: false,
    });
    assert.equal(info.host, "127.0.0.1");
    assert.equal(info.bindHost, "0.0.0.0");
    assert.equal(info.remoteAccess, false);
  });

  it("writes the Tailscale advertise host and remoteAccess:true when remote is on", () => {
    const info = buildDaemonFileInfo({
      pid: 42,
      bindHost: "0.0.0.0",
      port: 19824,
      token: "secret",
      remoteAccess: true,
      advertiseHost: "100.74.28.0",
    });
    assert.deepEqual(info, {
      pid: 42,
      host: "100.74.28.0",
      bindHost: "0.0.0.0",
      port: 19824,
      token: "secret",
      remoteAccess: true,
    });
  });

  it("never forces host back to 127.0.0.1 in remote mode", () => {
    const info = buildDaemonFileInfo({
      pid: 7,
      bindHost: "0.0.0.0",
      port: 19824,
      token: "t",
      remoteAccess: true,
      advertiseHost: "desktop-1point",
    });
    assert.equal(info.host, "desktop-1point");
    assert.notEqual(info.host, "127.0.0.1");
  });
});

describe("parseListenArgs (CLI / env, flag wins)", () => {
  const emptyEnv: NodeJS.Dict<string> = {};

  it("defaults bind to 127.0.0.1 and remote off", () => {
    const parsed = parseListenArgs([], emptyEnv);
    assert.equal(parsed.host, "127.0.0.1");
    assert.equal(parsed.advertiseHost, undefined);
    assert.equal(parsed.remoteAccess, false);
    assert.equal(parsed.port, 19824);
  });

  it("reads BB_DAEMON_HOST when --host is absent", () => {
    const parsed = parseListenArgs([], { BB_DAEMON_HOST: "100.74.28.0" });
    assert.equal(parsed.host, "100.74.28.0");
    assert.equal(parsed.remoteAccess, true);
  });

  it("lets --host win over BB_DAEMON_HOST", () => {
    const parsed = parseListenArgs(["--host", "127.0.0.1"], {
      BB_DAEMON_HOST: "100.74.28.0",
    });
    assert.equal(parsed.host, "127.0.0.1");
    assert.equal(parsed.remoteAccess, false);
  });

  it("reads BB_DAEMON_ADVERTISE_HOST and BB_REMOTE_ACCESS", () => {
    const parsed = parseListenArgs(["--host", "0.0.0.0"], {
      BB_DAEMON_ADVERTISE_HOST: "100.74.28.0",
      BB_REMOTE_ACCESS: "1",
    });
    assert.equal(parsed.host, "0.0.0.0");
    assert.equal(parsed.advertiseHost, "100.74.28.0");
    assert.equal(parsed.remoteAccess, true);
  });

  it("lets --advertise-host win over BB_DAEMON_ADVERTISE_HOST", () => {
    const parsed = parseListenArgs(
      ["--host", "0.0.0.0", "--advertise-host", "desktop-1point", "--remote-access"],
      { BB_DAEMON_ADVERTISE_HOST: "100.74.28.0" },
    );
    assert.equal(parsed.advertiseHost, "desktop-1point");
    assert.equal(parsed.remoteAccess, true);
  });

  it("lets --remote-access win over a falsy env value", () => {
    const parsed = parseListenArgs(["--remote-access"], { BB_REMOTE_ACCESS: "0" });
    assert.equal(parsed.remoteAccess, true);
  });

  it("accepts -H as an alias for --host", () => {
    const parsed = parseListenArgs(["-H", "100.74.28.0"], emptyEnv);
    assert.equal(parsed.host, "100.74.28.0");
    assert.equal(parsed.remoteAccess, true);
  });

  it("CLI wildcard bind without remote still advertises 127.0.0.1", () => {
    const parsed = parseListenArgs(["--host", "0.0.0.0"], emptyEnv);
    const info = buildDaemonFileInfo({
      pid: 1,
      bindHost: parsed.host,
      port: parsed.port,
      token: "t",
      remoteAccess: parsed.remoteAccess,
      advertiseHost: parsed.advertiseHost,
    });
    assert.equal(info.host, "127.0.0.1");
    assert.equal(info.bindHost, "0.0.0.0");
    assert.equal(info.remoteAccess, false);
  });

  it("CLI --host 0.0.0.0 --advertise-host <tailscale> does not rewrite to 127.0.0.1", () => {
    const parsed = parseListenArgs(
      ["--host", "0.0.0.0", "--advertise-host", "100.74.28.0"],
      emptyEnv,
    );
    const info = buildDaemonFileInfo({
      pid: 1,
      bindHost: parsed.host,
      port: parsed.port,
      token: "t",
      remoteAccess: parsed.remoteAccess,
      advertiseHost: parsed.advertiseHost,
    });
    assert.equal(info.host, "100.74.28.0");
    assert.equal(info.bindHost, "0.0.0.0");
    assert.equal(info.remoteAccess, true);
  });
});

describe("envTruthy", () => {
  it("accepts 1/true/yes/on and rejects empty/0/false", () => {
    assert.equal(envTruthy("1"), true);
    assert.equal(envTruthy("true"), true);
    assert.equal(envTruthy("YES"), true);
    assert.equal(envTruthy("on"), true);
    assert.equal(envTruthy("0"), false);
    assert.equal(envTruthy("false"), false);
    assert.equal(envTruthy(""), false);
    assert.equal(envTruthy(undefined), false);
  });
});

describe("allowCorsOrigin remote tighten", () => {
  it("refuses CORS when remoteAccess is true even if BB_CORS_ORIGINS matches", () => {
    const prev = process.env.BB_CORS_ORIGINS;
    process.env.BB_CORS_ORIGINS = "http://localhost:5173";
    try {
      assert.equal(allowCorsOrigin(originReq("http://localhost:5173"), false), "http://localhost:5173");
      assert.equal(allowCorsOrigin(originReq("http://localhost:5173"), true), null);
    } finally {
      if (prev === undefined) delete process.env.BB_CORS_ORIGINS;
      else process.env.BB_CORS_ORIGINS = prev;
    }
  });
});
