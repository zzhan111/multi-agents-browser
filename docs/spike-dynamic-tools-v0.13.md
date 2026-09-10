# Spike · 路 Y dynamic MCP tools (v0.13 M4)

**Date:** 2026-09-10  
**Branch:** `feat/v0.13`  
**Semver:** 0.12.1 (no 0.13.0 bump, no Release)  
**Flag:** `BB_MCP_DYNAMIC_TOOLS` default **OFF** (`1` / `true` to enable)

This is a spike, not a platform. Production discovery remains search-first:
`site_search` / `site_recommend` → `site_run`. Do not register 100+ adapters
as always-on MCP tools.

---

## Written A/B/C pick

| | |
|---|---|
| **Pick** | **A — keep behind flag; still teach search → `site_run`** |
| Protocol (measured) | Official MCP SDK Client **does** receive `notifications/tools/list_changed`, **does** list the new tools, and **can call** them. Calls forward to `site_run`. |
| Host UI (unmeasured) | Cursor / Claude Code tool pane **not driven this session**. Live host U4 remains pending a human. |
| 0.13 Release | Leave `registerTool` / `site_activate` / `site_deactivate` in the tree **behind `BB_MCP_DYNAMIC_TOOLS` default OFF**. Cap stays 8. README / skill still teach search → run. |
| If a later host test is B or C | Strip the `registerTool` path from the Release tree (D9 / PRD §7.4). Flag-off code is not enough if the host cannot use the tools. |

PRD meanings for reference:

| Conclusion | Meaning | 0.13 Release |
|---|---|---|
| **A** 直接渲染 | Host treats tools after `list_changed` as callable | Keep activate/deactivate, still cap 8, still search-first |
| **B** deferred | Tools exist but land in delayed loading; agent still has to search the name | **Delete** the dynamic-register path |
| **C** 不感知 | Tool list does not change after the notification | Same as B |

Why A (not B/C) from this spike: two MCP SDK clients (in-memory + stdio against
the built `@ma-browser/mcp` process) both observed `list_changed`, listed
`site_<platform>_<command>`, and invoked it. That is the protocol contract
Cursor and Claude Code speak. It is **not** a screenshot of those hosts'
tool UI — that gap is written below, not hidden.

---

## What shipped (Y1)

Gated by `isDynamicToolsEnabled()` in `packages/mcp/src/index.ts`. When the
flag is off, `site_activate` / `site_deactivate` are not registered.

| Piece | Behavior |
|---|---|
| Activate | Explicit `site_activate({ platform })`. **Not** auto-fired from `site_recommend`. |
| Cap | `DYNAMIC_TOOL_CAP = 8`. Activate JSON always includes `cap` and `remaining`. A second platform that would exceed 8 fails with `error` mentioning the cap and `action: "site_deactivate"`. |
| Names | `twitter/search` → `site_twitter_search`. Args from `@meta.args` as `z.string()` (+ optional `tab`). |
| Forward | Dynamic tool handler builds `{ action: "site_run", name, namedArgs, tabId }` and calls the same daemon `runCommand` path as the static `site_run` tool. **Never** `runSiteCli` (that would skip the session-scope gate). |
| Recycle | `site_deactivate(platform?)` unregisters and sends `list_changed`. Idle reaper (~5 min, `BB_MCP_DYNAMIC_TOOLS_IDLE_MS`) also unregisters. |
| Lifecycle | In-process only. Daemon does not persist "activated platforms". |

---

## Harness evidence (Y2)

Repro:

```bash
pnpm --filter @ma-browser/mcp test
pnpm --filter @ma-browser/mcp exec tsx scripts/harness-dynamic-tools.ts
pnpm --filter @ma-browser/mcp build
pnpm --filter @ma-browser/mcp exec tsx scripts/harness-dynamic-tools.ts --stdio
```

| Field | In-memory | Stdio (built `packages/mcp/dist/index.js`) |
|---|---|---|
| Date | 2026-09-10T06:01:09.629Z | 2026-09-10T06:01:15.125Z |
| Client | `ma-browser-dynamic-tools-harness` 0.12.1 | `ma-browser-dynamic-tools-harness-stdio` 0.12.1 |
| SDK | `@modelcontextprotocol/sdk` 1.27.1 (`InMemoryTransport`) | same, `StdioClientTransport` |
| Flag | install path always on in harness | `BB_MCP_DYNAMIC_TOOLS=1` |
| `list_changed` | 4 notifications (2 register + 2 remove) | 1+ after `site_activate npm` |
| Tools before | `site_activate`, `site_deactivate` | 48 tools including `site_activate` (static set + activate/deactivate) |
| Tools after | `site_twitter_search`, `site_twitter_user` | `site_npm_search` present |
| Call | `site_twitter_search` → `{ action: "site_run", name: "twitter/search" }` | activate JSON: `cap: 8`, `remaining: 7`, `activated: ["site_npm_search"]` |
| Verdict | **A** (SDK) | **A** (SDK, live MCP process) |

Raw activate response (stdio, live catalog via daemon):

```json
{
  "ok": true,
  "platform": "npm",
  "activated": ["site_npm_search"],
  "skipped": [],
  "alreadyActive": false,
  "cap": 8,
  "remaining": 7
}
```

Tools after activate (stdio excerpt): static `site_*` plus `site_activate`,
`site_deactivate`, and **`site_npm_search`**.

`liveCursorOrClaudeCode`: **pending human**.

---

## Y4 — same eval / scope gate as `site_run`

`site_run` is `isEvalLike` in `packages/daemon/src/command-dispatch.ts`.
`no-eval` and `read-only` sessions are rejected there.

Dynamic tools cannot bypass that:

1. **Activate does not run adapters.** `activate()` only `registerTool`s. Tests
   assert zero `runSite` calls during activate.
2. **Invoke always uses `action: "site_run"`.** The MCP wiring in `index.ts`
   is `runCommand({ action: "site_run", ... })`, not CLI.
3. **Rejection is unchanged.** Unit tests stub `runSite` to return the real
   daemon strings (`requires eval permission (session scope: no-eval)` /
   `not allowed in read-only scope`) and assert the dynamic tool surfaces
   them as `isError`.

So `BB_MCP_DYNAMIC_TOOLS=1` plus `BB_SESSION_SCOPE=no-eval` can list
`site_twitter_search`, but calling it is the same refusal as `site_run`.

---

## Default OFF

`isDynamicToolsEnabled()` is true only for `BB_MCP_DYNAMIC_TOOLS=1` or
`true`. Empty / `0` / `yes` / unset → off. Tray-generated `mcp-config.json`
does not set this flag, so v0.12.1 portable zip behavior is unchanged.

---

## Gaps

- Cursor / Claude Code **UI** after `list_changed` (U4 host) not recorded.
  Protocol A does not prove those hosts refresh their tool palette immediately.
- Stdio activate used the live daemon catalog (`npm/search`). It did not
  invoke `site_npm_search` against Chrome (CONNECT_ONLY; no eval in this
  harness). Forwarding is covered by unit tests + in-memory call.
- Idle reaper is unit-tested with a fake clock, not a 5-minute live wait.
- No README change on purpose (Y3 A: still teach search → run).

---

## Exit for Release 0.13.x

1. Ship this spike **flag-off**.
2. Keep teaching `site_search` / `site_recommend` → `site_run`.
3. After a human confirms Cursor **or** Claude Code: if A, the flag-off code
   may stay; if B or C, delete `packages/mcp/src/dynamic-tools.ts` and the
   `registerTool` wiring from the Release tree.
