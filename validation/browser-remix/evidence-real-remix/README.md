# Real Remix IDE attempts, 2026-11-08

Both optional runs used installed Chrome 156.0.8078.80 in fresh browser contexts, the actual
packed SDK 0.1.0 (digest in each result), and the public Remix website. Both exited 1 and are
blocked. No compilation or real plugin-host transport succeeded.

- `2026-11-08/`: first recorded run, HTTP 200, website version 2.6.13. Reached the plugin manager;
  accessible-button selector timed out. `blocked-ui.txt` and `blocked.png` show the external
  plugin control was visible. This motivated changing the selector to its visible text.
- `2026-11-08-final/`: follow-up with that selector, HTTP 200. The website's promotional overlay
  intercepted clicks on Save Preferences. Result JSON contains the exact Playwright timeout and
  request failures with query parameters stripped. Screenshot and UI text preserve the blocker.

Command for the latest attempt, from repository root (supply your candidate directory):

```sh
node validation/browser-remix/run-real-remix.mjs --tarballs <candidate-tarballs-directory> --output validation/browser-remix/evidence-real-remix/2026-11-08-final
```

Use a different output directory to preserve these records. This remote test is optional and
not wired into the default test script or CI. The current script's plugin connection and compiler
request branches were not reached in these runs. It has no deployment, wallet or verification
submission operation. The page's promotional text about Sepolia verification is not our evidence.

Earlier exploratory page loads established the UI version and an intermittent pointer-event
blocker; they produced no compiler artifacts. Only these two saved runs are durable evidence.
