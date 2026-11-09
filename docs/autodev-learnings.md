1. Node 22's test runner cancels tests pending only on an unref'd timer; don't unref timers guarding awaited promises; test under node 22.

2. Daemon lifecycle tests spawn packages/daemon/dist/index.js, so run pnpm build before pnpm -F daemon test or they time out spuriously.

3. Test HttpServer + CdpConnection without Chrome by serving /json/version plus a ws WebSocketServer (see __tests__/command-timeouts.test.ts).

4. Piping scripts/e2e.mjs into tail can hang on leftover child processes holding stdout open; redirect its output to a file instead.
