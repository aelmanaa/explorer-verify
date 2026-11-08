# network

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: every request to the backend failed before it answered, retries included. DNS, TLS, a
closed connection or a CORS block in a browser all end here, or every request took longer than the
per-request timeout. `details.attempts` gives the number of requests tried.

Through your server handler (`handlerUrl`), a 408 `request-timeout`, a 502 `upstream-error` or a
504 `upstream-timeout` of the handler ends here too, after the retries. The handler's code is then
only in the message
([how the client reads a refusal](../server-handler.md#how-the-client-reads-a-refusal)).

Fix: check the network connection and the explorer's status page, then call again.

Default hint: Check the network connection and the explorer's status page, then call again.

From the CLI: Check the network connection and the explorer's status page, then run the command
again.

Retryable: yes.

Exit code: 5

## A module that fails to load

`explorer-verify` loads each explorer client, the routing table, the constructor argument code,
the proxy-link code and the `handlerUrl` code with a dynamic `import()`, the first time a call
needs it. A bundler that splits code puts each in a file of its own. When that file does not load,
for example after a new deployment removed the files an open page still asks for, or when the
network is down, the call throws `network`:

- The message names the module, such as `Loading the sourcify client failed.` or
  `Loading the routing table failed.`
- `details.backend` is the route's backend, or `sourcify` for the routing table when the call names
  none, and `etherscan-v2` for the `handlerUrl` code. `details.attempts` is 1.
- `cause` is the error the runtime gave for the `import()`, such as
  `TypeError: Failed to fetch dynamically imported module`, with API keys removed.
- The hint is: Check the network connection and that the site serves every file of its build, then
  call again.

No request was sent to an explorer. A later call loads the module again; a module that loaded
once is kept. In a page, reload it so it asks for the files of the current deployment. In
`verifyEach()`, the failure is the outcome of each backend that needed the module, and the other
backends run.

`explorer-verify/core` loads nothing: its caller passes the clients and the table, so it never
throws this case. A load that does not finish within `timeoutMs` throws [`timeout`](timeout.md),
and an abort rejects with `signal.reason`, as for any request.

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
