1. DOM.setFileInputFiles fires input and change once each, so arm one-shot listeners and dispatch manually only as a fallback.

2. Errors thrown in dispatchRequest reach the CLI as 'Daemon HTTP 400: {json}'; return fail() from the case for a readable message.

3. An e2e check that opens a new tab moves that agent's current tab; close the tab or run the check late so default-tab checks still pass.

4. cli daemon-startup 'CDP port is reachable' fails on main here, breaking husky pre-commit; verify against main before blaming your change.
