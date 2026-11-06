# 0054: A module that fails to load throws `network`

Status: Accepted (2026-11-06). Amends the point of
[decision 0031](0031-clients-load-on-demand-and-chunks-measured-apart.md) that a client which fails
to load rejects with the loader's error, and the same rule for the routing table in
[decision 0040](0040-routing-table-loads-on-demand.md) and the `handlerUrl` code in
[decision 0046](0046-handler-url-and-keyed-backend-names.md).

Research: none (maintainer choice).

## Context

Issue [#236](https://github.com/aelmanaa/explorer-verify/issues/236) reports that a module the
default entry loads with a dynamic `import()` (a client, the routing table, the constructor
argument code, the proxy-link code or the `handlerUrl` code) rejected the call with the runtime's
own error when it failed to load, such as `TypeError: Failed to fetch dynamically imported
module`. That error has no `code`, no `retryable` flag and no hint (R-DX-3), so a caller or an
agent cannot tell it from a bug. `verifyEach()` already turned such a failure into a `network`
outcome; `verify()`, `dryRun()`, `checkStatus()` and `linkProxy()` did not.

Every load runs through `bounded()` in `flow/verify.ts`, which also ends it on an abort or when the
budget runs out.

## Decision

1. `bounded()` turns any rejection of the loader into `network`, retryable, with
   `details.attempts` 1, `details.backend` the backend it already names in `timeout`, the message
   `Loading <module> failed.`, the loader's error as `cause` and its own hint: "Check the network
   connection and that the site serves every file of its build, then call again." The cause is
   redacted with the call's `apiKeys` and `rpcUrl` secrets.
2. An abort still rejects with `signal.reason`, and a load that runs out of budget still throws
   `timeout`. Only the loader's own rejection changes.
3. `verifyEach()` keeps its outcomes: a failed client or table load is that entry's `network`
   outcome, now built by `bounded()`; the table's error is rebuilt to name each entry's backend,
   as `timeout` was, with every entry's key removed from the cause.
4. `explorer-verify/core` reaches no dynamic `import()` (decision 0052): its caller passes the
   clients and the table, and its loaders return what they hold. It never throws this case.

## Why `network`, not a new code

- A failed chunk load is a failed fetch of a file: the network was down, or the deployment no longer
  serves the file the page asks for. `network` means "a request failed before it answered", is
  retryable and exits 5, which fits both. A later call loads the module again.
- No request reached an explorer. The message and the hint say which module failed and what to
  check, so a caller who reads only the code still retries, and a person reading the hint is not
  sent to the explorer's status page.
- A new code adds a row to the error catalogue, its redactor, its exit code, its hint and its page,
  and that catalogue ships in every bundle. It would also change `errors.ts` while another change
  rewrites the details there.

## Consequences

- A caller that caught the raw `TypeError` now gets an `ExplorerVerifyError`. Its `cause` holds a
  redacted copy of that error.
- A loader that rejects with an `ExplorerVerifyError` is wrapped too. No loader the library ships
  does; only tests inject one.
- Size, esbuild 0.28.2, minified, gzip, measured on 2026-11-06 against main at `8953d09`:
  `verify` grows by 78 bytes, `checkStatus` by 67, `linkProxy` by 73 and `verifyEach` by 20,
  which drops the wrapping it did itself. The client and table chunks do not change.
