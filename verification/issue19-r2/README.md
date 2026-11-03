# issue #19 — r2: browser login state for generated news packages

All files here come from the final version of this branch, on Linux with the
isolated Chromium + daemon + `BB_BROWSER_HOME` that `scripts/e2e.mjs` creates
(daemon started with `--strict-cdp`, so it never attaches to another browser).

| file | command | result |
|---|---|---|
| `build.txt` | `pnpm build` | success |
| `lint.txt` | `pnpm lint` | 3/3 tasks, no errors |
| `unit-tests.txt` | `TMPDIR=<short dir> pnpm test` | shared 23 pass / 1 skip (Windows-only), daemon 151 pass / 13 skip (protocol-drift needs Chrome on :19222), cli 17, mcp 1; 0 fail |
| `e2e.txt` | `E2E_EVIDENCE_DIR=verification/issue19-r2 node scripts/e2e.mjs` | 12/12 PASS |
| `1-generated-and-run.png`, `2-changed-and-auto-healed.png` | written by the run above | fixture report: generate → run → change → auto-heal → run |
| `e2e-regression-hostname-match.txt` | same E2E (`E2E_ONLY=login-only`) with site_run's tab match reverted to hostname-only | FAIL `Failed to fetch` — the r2 failure, reproduced |

## What the login-only E2E covers

1. `site generate` without `--browser` fails (0/4 checks) and writes nothing.
2. Log in in the browser, `site generate --browser` passes; no tab left behind;
   generated files and `_package.json` contain no cookie.
3. Only a same-hostname/other-port tab is open: `site run latest → article`
   still uses the manifest's origin (title, URL, ≥80 chars of text), and the
   other tab is neither used nor navigated. Explicit `--tab` still works.
4. `site heal --browser` → `healthy`.
5. The site moves its feed (`/rss.xml` → `/feed.xml`); the next normal
   `site run` auto-heals with the browser login state and passes latest → article
   — no manual heal, no daemon restart; tab count unchanged, existing tabs open.

Timeouts, ready-timeout cleanup, logout (401) not overwriting the package and
the fallback rules are unit-tested in `packages/shared/src/__tests__/news-generator.test.ts`.

## Root cause of the r2 failure

`site run` picked any tab whose *hostname* matched the adapter domain. E2E
fixtures all live on `localhost`/`127.0.0.1` with different ports, so the run
used another fixture's tab and the same-origin `fetch` failed. Generated
packages now require the exact origin of their manifest base.

## E2E harness fixes found on the way

- `closeBrowser()` left a 10s fallback timer that later killed the *restarted*
  Chromium; that made every check after the browser restart flaky.
- Without `--strict-cdp` the test daemon, when its Chromium was gone, scanned
  well-known ports and attached to the user's own browser (port 19825). During
  this work fixture tabs were opened there; they were closed again (only tabs on
  dead fixture ports), and 5 fixture screenshots the daemon wrote to
  `~/.pinix/data/browser/screenshots` were removed. Evidence screenshots now come
  from a one-shot headless Chromium with a throwaway profile.

## Known limits / not done

- Full-site acceptance for 36kr / Caixin and non-RSS discovery stay in #19.
- Not run: native `/loop` (this round ran under the outer autodev runner, not a
  visual native loop) and Windows.
- Exclusive-lease skipping for probe tabs is implemented (daemon: same check as
  site_run; CLI: skips tabs another session holds) but not E2E-tested.
