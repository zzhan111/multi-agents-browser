1. Write in-page adapter helpers as a String.raw constant, not fn.toString(): tsx/esbuild may inject __name helpers that break in the page.

2. Test generated adapters in Node by evaluating buildAdapterScript output with global fetch against a node:http fixture; no Chromium needed.

3. Serve two test fixtures on 127.0.0.1 and localhost to get a real domain change, so adapter.domain actually differs.

4. Run CLI subprocess tests against packages/cli/dist/index.js; src/index.ts requires the build-time __BB_BROWSER_VERSION__ define.

5. To import ESM-only @ma-browser/shared, use an .mjs file; tsx -e runs as CommonJS.

6. Pre-commit runs build and tests; retain the output and check failures before retrying.

7. Check temporary-volume quota after EDQUOT; exhausted space can prevent shell commands, builds, and pushes.
