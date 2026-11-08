# handler-refused

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: you set `handlerUrl`, and your [server handler](../server-handler.md#refusals),
`createVerifyHandler`, refused the request before it reached Etherscan. `details.handlerCode` holds
the handler's code, `details.status` the HTTP status and `details.excerpt` the start of its answer,
redacted:

| `details.handlerCode`    | Status | What to change                                                                               |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------- |
| `chain-not-allowed`      | 403    | Add the chain ID to the handler's `chains` option, or verify on a chain it serves            |
| `address-not-allowed`    | 403    | Add the contract's deployer or factory to the handler's `deployers` option                   |
| `action-not-allowed`     | 403    | Set `allowProxyLink` to link a proxy through the handler. It forwards no other action        |
| `body-too-large`         | 413    | Raise the handler's `maxBodyBytes` above the size of the submitted input                     |
| `forbidden-field`        | 400    | Check that `handlerUrl` points at `createVerifyHandler`, on the same explorer-verify version |
| `bad-request`            | 400    | The same                                                                                     |
| `method-not-allowed`     | 405    | The same                                                                                     |
| `unsupported-media-type` | 415    | The same                                                                                     |

The handler's other codes map to other errors. See
[how a client reads a refusal](../server-handler.md#how-the-client-reads-a-refusal).

The client maps a code only when it comes with the status in the table.

Fix: change the `createVerifyHandler` option that the table names, redeploy the handler, then call
again. For the first four codes, the error's hint names the option.

Default hint: Do not retry. Fix the createVerifyHandler option or the request that
details.handlerCode names.

From the CLI: The server handler refused the request with `<handler code>`. Do not retry: change the
handler's createVerifyHandler options for it, redeploy the handler, then run the command again.

Retryable: no. The refusal holds until the handler's options or the request change. Nothing was
submitted to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
