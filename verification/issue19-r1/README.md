# #19 round 1 — automatic self-heal on `site run`

Commands (Linux, isolated BB_BROWSER_HOME, headless Chromium; TMPDIR pointed at a short path on /home because /tmp was over quota):

```
pnpm build && pnpm lint
(cd packages/<shared|daemon|cli|mcp> && pnpm test)   # turbo drops TMPDIR, so packages were run directly
CHROMIUM=/usr/bin/chromium node scripts/e2e.mjs
```

- `e2e.txt` — full E2E output. The last check generates `e2e-news` from a 127.0.0.1 fixture, runs latest → article,
  moves the fixture to localhost (301), then runs `site run e2e-news/latest` with no `site heal` and no daemon restart:
  the daemon auto-heals and retries once, and latest → article passes against the new origin.
- `unit-tests.txt` — per-package node:test summaries.

Not in this round: screenshots/screen recording, structure-change E2E, 36kr/Caixin, login-state fixture.
No credentials in these files.
