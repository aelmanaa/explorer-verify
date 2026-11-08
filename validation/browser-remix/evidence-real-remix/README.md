# Real Remix IDE attempts, 2026-11-08

The optional runs used installed Chrome 156.0.8078.80 in fresh browser contexts, the actual
packed SDK 0.1.0 (digest in each result), and the public Remix website. The site displayed
version 2.6.13. Attempts 04 and 05 passed with exit 0. Earlier blockers remain intact.

- `2026-11-08/`: first recorded run, HTTP 200. Reached the plugin manager;
  accessible-button selector timed out. `blocked-ui.txt` and `blocked.png` show the external
  plugin control was visible. This motivated changing the selector to its visible text.
- `2026-11-08-final/`: initial follow-up with that selector, HTTP 200. The website's promotional
  overlay intercepted clicks on Save Preferences. Result JSON contains the exact Playwright
  timeout. Screenshot and UI text preserve the blocker. This earlier directory name does not
  imply it was the last attempt.
- `2026-11-08-attempt-03/`: got past onboarding, disabled optional performance analytics and
  submitted the actual external-plugin form. Chrome refused the iframe request with
  `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`; exited 1, status blocked.
- `2026-11-08-attempt-04/`: granted `local-network-access` only to the Remix origins in the
  fresh context. Actual plugin-host handshake and `solidity.compileWithParameters` succeeded
  for Counter with compiler `0.8.24+commit.e11b9ed9`. Captured the authentic compilation response
  and SDK input rebuilt from metadata. Performance analytics disabled; no promotion appeared.
- `2026-11-08-attempt-05/`: the promotion appeared. The handler inspected its DOM and clicked
  `button.nudge-widget-close` (title `Dismiss`); `promotion-dom.html` records that actual control.
  Performance analytics disabled. Actual plugin-host compilation and public SDK calls passed.
  `compilation.json` is the real method response, including Remix's compiler input, output and
  version. `metadata.json` extracts the actual compiled Counter metadata. `build-info.json`
  locally wraps the **same response's** input, output and version, rather than claiming a Remix
  file export. `sdk-built-input.json` records the browser SDK's metadata rebuild and
  `sdk-built-from-build-info.json` its build-info path, including creation bytecode. The plugin
  subscribed to `compilationFinished`, but no event was observed for this method call; this is
  authentic response/metadata evidence, not event evidence.

Command for the latest attempt, from repository root (supply your candidate directory):

```sh
node validation/browser-remix/run-real-remix.mjs --tarballs <candidate-tarballs-directory> --output validation/browser-remix/evidence-real-remix/2026-11-08-attempt-05
```

Use a different output directory to preserve these records. This remote test is optional and
not wired into the default test script or CI. Chrome local-network permission is scoped to these
fresh contexts; no browser security feature is disabled. The test does not connect a wallet,
select a deployment environment, deploy, call RPCs or submit verification. It proves compilation
and public-SDK compatibility for this sample through the real host, not live explorer acceptance
or upstream adoption. The original 16 local results are unchanged.

The page's promotional text about Sepolia verification in earlier screenshots is not our evidence.
Earlier exploratory page loads established the UI version and DOM structure; they produced no
compiler artifacts. The saved runs above are the durable evidence.
