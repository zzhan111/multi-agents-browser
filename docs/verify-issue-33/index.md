# Issue #33 — review and integration of PR #34 / #36 / #38

Integration branch `auto/review-integrate-30-32-r1` = `main`
+ `auto/issues-30-31-32-r1` (#34, issue #30)
+ `auto/issues-31-32-r1` (#36, issue #31)
+ `auto/issue-32-upload-r1` (#38, issue #32)
+ one fix commit (below). All three merged with no textual conflicts. The one
conflict was in behavior (#38 vs #34), fixed here.

## Evidence

| File | What it shows |
|---|---|
| [health.png](health.png) ([health.txt](health.txt)) | Live isolated daemon: `status` is `Health: ok`. Then a hung `eval` returns a `[cdp]` timeout that names `Runtime.evaluate` and gives a recovery hint and the `BB_COMMAND_TIMEOUT_EVAL_MS` override. A `wait` queued behind it returns a `[dispatch]` timeout that names the cause. `status` then shows `degraded`, the consecutive timeouts, the in-flight orphans and a hint (#34). |
| [upload.png](upload.png) ([upload.txt](upload.txt)) | Live isolated daemon: `snapshot -i` tags the file input `[file accept=".txt"]`. `upload` succeeds and `eval` reads back `files[0].name`. It also shows readable errors for an accept mismatch, a missing file, a non-file target and multiple files on a single input (#38). |
| [test-summary.png](test-summary.png) ([test-summary.txt](test-summary.txt)) | Results on the integration branch: `pnpm build` and `pnpm lint` exit 0. `pnpm turbo run test --force --continue` passes shared 30/30, mcp 1/1 and daemon 177/177 (13 skipped need a real Chrome on :19222); cli is 16/17 because of the known daemon-startup failure. `node scripts/e2e.mjs` passes 12/12, upload included. The new upload-timeout test passes. |

Reproduce after `pnpm build`:
- `bash docs/verify-issue-33/capture.sh` regenerates the two `.txt` captures with an isolated Chromium, daemon and `BB_BROWSER_HOME`.
- `node docs/verify-issue-33/render.mjs <in.txt> <out.png> [title]` renders a capture to PNG.

## Review

### #34 — timeout classification + `/status` health (issue #30)

Verified live and by tests: per-action budgets, client grace, `kind=cdp|dispatch|queue|cdp_connect`, orphan tracking, `degraded`/`stalled`, and recovery hints.

- **must-fix (cross-PR, fixed here):** #38 wrapped `upload` in its own 15 s
  `withTimeout`. With #34 merged, this caused two problems. A hung
  `DOM.setFileInputFiles`, such as a wedged tab, came back as a plain
  `success:false` with HTTP 200, so it was never classified as `[cdp]` and
  never counted in `/status` health. It was also cut off at 15 s even when
  `BB_COMMAND_TIMEOUT_UPLOAD_MS` or `timeoutMs` allowed more. The fix removes
  the private timer, so `upload` now runs under the per-action budget (default
  30 s). The new test `upload under the per-action budget` in
  `packages/daemon/src/__tests__/command-timeouts.test.ts` uses a 16 s budget.
  It fails on the pre-fix code (HTTP 200 at 15 s) and passes after the fix
  (504 `[cdp]` with `DOM.setFileInputFiles`, counted in health).
- wont-fix (cosmetic): `status` prints `Last error:` even when health is `ok`, for example after an upload validation error.
- wont-fix: when a command is queued behind a CDP-hung command, it is classified `[dispatch]` and gets the generic daemon-side hint. The error text already names the cause ("queued behind N earlier timed-out command(s)").

### #36 — tray left-click confirm + bring to front (issue #31)

This was a static review plus the contract tests (`packages/shared/src/__tests__/windows-tray.test.ts`, which pass). Checked:
- Left-click asks for confirmation before anything else.
- Cancel returns without acting.
- Repeated clicks do not stack dialogs (`$script:prompting`).
- Headless→headed reuses `Switch-BrowserMode`, and a 45 s deadline polls from `Update-Tray` to bring the new window to the front.
- Failures show as balloon tips.
- Right-click still opens the menu.

- No must-fix found.
- wont-fix: Windows' foreground lock can still refuse `SetForegroundWindow`. The TopMost owner form reduces this, and a refusal shows as a balloon error rather than failing silently.
- Not run here: this is Linux CI with no pwsh and no Windows desktop. Hands-on check on Windows: `scripts/check-windows-tray.ps1 -Mode headed -ExpectForeground -DelaySeconds 10`.

### #38 — `upload` command (issue #32)

Verified by the e2e test (ref, selector and label targets, input/change events, custom widgets that clear the input, readable errors), by the unit tests and by the live capture.

- must-fix: the timeout integration with #34 above, fixed here.
- wont-fix: `snapshot` reports a file `<input>` as role `button` (existing role mapping). The `[file accept=…]` suffix added by #38 makes it clear.

## Known failures (pre-existing, not caused by this integration)

- `packages/cli` › `daemon startup with CDP available` › `daemon starts successfully when CDP port is reachable` fails with `daemon.json not created in time`. The brief already lists this as a known failure.
- If you run `pnpm test` without `--continue`, turbo stops the remaining tasks once that cli test fails. A daemon test file that is still running then reports `Promise resolution is still pending but the event loop has already resolved`. This is a side effect of the abort, not a daemon failure: with `--continue`, the daemon suite passes 177/177.
