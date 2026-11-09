1. The husky pre-commit hook runs full pnpm build && pnpm test, so a known failing test blocks commits; run checks yourself and note why --no-verify.

2. Run tests via `pnpm turbo run test --force --continue`; without --continue one failure kills the rest and node:test shows bogus pending errors.

3. Command-level private timeouts shorter than the per-action budget hide hangs from the [cdp]/[dispatch] classifier and /status; use commandTimeoutMs.

4. A regression test for a timeout-cap bug needs a budget above the old cap; a short budget passes on both the old and new code.

5. On Linux, `/usr/lib/chromium/chromium --headless=new --screenshot` renders an HTML <pre> of terminal output into a real PNG for evidence.
