1. Write in-page adapter helpers as a String.raw constant, not fn.toString(): tsx/esbuild may inject __name helpers that break in the page.

2. Test generated adapters in Node by evaluating buildAdapterScript output with global fetch against a node:http fixture; no Chromium needed.

3. Serve two test fixtures on 127.0.0.1 and localhost to get a real domain change, so adapter.domain actually differs.

4. Run CLI subprocess tests against packages/cli/dist/index.js; src/index.ts requires the build-time __BB_BROWSER_VERSION__ define.

5. To import ESM-only @ma-browser/shared, use an .mjs file; tsx -e runs as CommonJS.

6. Pre-commit runs build and tests; retain the output and check failures before retrying.

7. /tmp can exceed quota (EDQUOT) and block builds and pushes; set TMPDIR to a short /home path, as Chromium rejects long socket paths.

8. Run package tests directly when TMPDIR matters; turbo's strict env mode drops it.

9. *.log files are gitignored, so commit verification logs as .txt.

10. Generated-package adapters must open new tabs at the manifest base URL, not https://<domain>, so http and port fixtures work.

11. Auto-heal only on adapter failures (in-page exception or {error} result); bad args and lease conflicts are not site changes.

12. Some Chromium launchers rewrite /proc/<pid>/cmdline into one space-joined string; split args on " --" too, not only on NUL.

13. Keep tests off CDP auto-discovery: the dev machine's real managed browser listens on 19825. Pass explicit ports, or call discoverCdpEndpoints({ ports, processes: false }) against fake servers.
