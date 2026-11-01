1. CLI subprocess tests must run packages/cli/dist/index.js, not src via tsx: src/index.ts needs the build-time define __BB_BROWSER_VERSION__.

2. `tsx -e` runs as CommonJS and can't import ESM-only @ma-browser/shared; use an .mjs file importing packages/shared/dist/index.js instead.

3. The pre-commit hook runs the full build and tests (~1 min, verbose output); grep the commit output for failures instead of reading it all.
