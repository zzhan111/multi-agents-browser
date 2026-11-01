1. Write in-page adapter helpers as a String.raw constant, not fn.toString(): tsx/esbuild may inject __name helpers that break in the page.

2. Test generated adapters in Node by evaluating buildAdapterScript output with global fetch against a node:http fixture; no Chromium needed.

3. Serve two test fixtures on 127.0.0.1 and localhost to get a real domain change, so adapter.domain actually differs.
