# network

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Every request to the backend failed before it answered, retries included.

## How to fix

Fix: check the network connection and the explorer's status page, then call again.

For a module that failed to load, check that the site serves every file of its build, then reload
the page.

From the CLI: Check the network connection and the explorer's status page, then run the command
again.

## Facts

Retryable: yes.

Exit code: 5

Sent to an explorer: maybe. A submit that got no answer may have reached the explorer.

Default hint: Check the network connection and the explorer's status page, then call again.

For end users: The explorer could not be reached. Check the network connection and the explorer's
status page, then try again.

## Why

Cause: every request to the backend failed before it answered, retries included. DNS, TLS, a
closed connection or a CORS block in a browser all end here, or every request took longer than the
per-request timeout. `details.attempts` gives the number of requests tried.

Through your server handler (`handlerUrl`), these refusals of the handler end here too, after the
retries:

- a 408 `request-timeout`;
- a 502 `upstream-error`;
- a 504 `upstream-timeout`.

The handler's code is then only in the message
([how the client reads a refusal](../server-handler.md#how-the-client-reads-a-refusal)).

## A module that fails to load

`explorer-verify` loads some of its code with a dynamic `import()`, the first time a call needs
it:

- each explorer client;
- the routing table;
- the constructor argument code and the proxy-link code;
- the `handlerUrl` code.

A bundler that splits code puts each in a file of its own. When that file does not load, the call
throws `network`. That happens after a new deployment removed the files an open page still asks
for, or when the network is down.

The error then reads as follows:

| Field              | Contents                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `message`          | Names the module, such as `Loading the sourcify client failed.`                                 |
| `details.backend`  | The route's backend; `sourcify` for the table with no route; `etherscan-v2` for `handlerUrl`    |
| `details.attempts` | 1                                                                                               |
| `cause`            | The runtime's error for the `import()`, with API keys removed                                   |
| `hint`             | Check the network connection and that the site serves every file of its build, then call again. |

A typical `cause` is `TypeError: Failed to fetch dynamically imported module`.

No request was sent to an explorer. A later call loads the module again; a module that loaded
once is kept. In a page, reload it so it asks for the files of the current deployment. In
`verifyEach()`, the failure is the outcome of each backend that needed the module, and the other
backends run.

`explorer-verify/core` loads nothing: its caller passes the clients and the table, so it never
throws this case. A load that does not finish within `timeoutMs` throws [`timeout`](timeout.md),
and an abort rejects with `signal.reason`, as for any request.

## In code

Check the code, then call again later:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "network")) {
    const { backend, attempts } = error.details;
    console.error(`${backend}: ${String(attempts)} requests failed.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
