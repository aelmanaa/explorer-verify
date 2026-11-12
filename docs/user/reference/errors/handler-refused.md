# handler-refused

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Your server handler refused the request before it reached Etherscan.

## How to fix

Fix: change the `createVerifyHandler` option that the table under [Why](#why) names, redeploy the
handler, then call again. For the first four codes, the error's hint names the option.

From the CLI: The server handler refused the request with `<handler code>`. Do not retry: change the
handler's createVerifyHandler options for it, redeploy the handler, then run the command again.

## Facts

Retryable: no. The refusal holds until the handler's options or the request change.

Exit code: 2

Sent to an explorer: no.

Default hint: Do not retry. Fix the createVerifyHandler option or the request that the handler's
refusal code names (details.handlerCode).

For end users: The verification server refused the request. Report it to the tool's maintainer;
trying again will not help.

## Why

Cause: you set `handlerUrl`, and your [server handler](../server-handler.md#refusals),
`createVerifyHandler`, refused the request. The error holds what it answered:

| Field                 | Contents                                    |
| --------------------- | ------------------------------------------- |
| `details.handlerCode` | The handler's refusal code                  |
| `details.status`      | The HTTP status                             |
| `details.excerpt`     | The start of the handler's answer, redacted |

Each refusal code points to one change:

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

The client maps a code only when it comes with the status in the table. The handler's other codes
map to other errors. See
[how a client reads a refusal](../server-handler.md#how-the-client-reads-a-refusal).

## In code

Check the code, then read the handler's refusal code:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "handler-refused")) {
    console.error(`Handler refused: ${error.details.handlerCode}.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
