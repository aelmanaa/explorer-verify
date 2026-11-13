# Verify a contract from a dapp

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who add contract verification to a web dapp.

You need: Node 22.18 or later and a web project with a bundler such as Vite. No wallet, no
deployment and no API key.

In this tutorial you build the verification part of a dapp. The page verifies a contract that is
already deployed, keeps the job's handle across a reload and shows the result. It uses a sample
request for a Greeter contract on Sepolia, so nothing is deployed and no secret reaches the
browser.

## Step 1: Add the library and the sample request

Install the library in the web project:

```sh
npm install explorer-verify
```

Download the sample request into `src/`. It holds the chain, the address, the compiler version and
the Standard JSON input of a Greeter that Sourcify already verified:

```bash
repo=https://raw.githubusercontent.com/aelmanaa/explorer-verify/main
curl -fsSL -o src/greeter-sepolia.json \
  "$repo/docs/user/start/greeter-sepolia.json"
```

## Step 2: Run a dry run

A dry run checks the input, picks the explorer and looks the contract up once. It never submits.
Save this module as `src/dry-run.ts` and run it with `node src/dry-run.ts`:

```ts [src/dry-run.ts]
import { dryRun, validateInput } from "explorer-verify";

import greeter from "./greeter-sepolia.json" with { type: "json" };

// validateInput() checks the parsed JSON and returns a typed VerifyInput.
const input = validateInput(greeter);
const plan = await dryRun(input);
console.log(plan.status, plan.backend, plan.apiHost, plan.lookup);
```

It prints:

```text
dry-run sourcify sourcify.dev exact
```

With no key, the routing table sends Sepolia to Sourcify, which needs none. `exact` means Sourcify
already holds the contract, so a real run submits nothing new.

## Step 3: Verify and save the handle

`verify()` looks the contract up first. When the explorer does not hold it yet, `verify()` submits
the source and polls the job until it ends. Save this module as `src/verify.ts`. `show` writes a
line where the user sees it:

```ts [src/verify.ts]
import { ExplorerVerifyError, verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

export const PENDING_KEY = "greeter-verification";

function summary(result: VerifyResult): string {
  if (result.status === "failed") {
    return `Sourcify rejected the source: ${result.reason}`;
  }
  return [result.status, `(${result.match})`, result.explorerUrl].join(" ");
}

/**
 * Verifies on Sourcify, saves the handle for a reload, and shows each step with
 * `show`.
 */
export async function verifyOnSourcify(
  input: VerifyInput,
  show: (line: string) => void,
): Promise<void> {
  try {
    const result = await verify(input, {
      onEvent: (event) => {
        if (event.type === "verify.submitted") {
          // Saved before the first poll, so a reload can resume the job (step
          // 5).
          localStorage.setItem(PENDING_KEY, event.handle);
          show(`Submitted. Handle: ${event.handle}`);
        }
      },
    });
    localStorage.removeItem(PENDING_KEY);
    show(summary(result));
  } catch (error) {
    if (
      error instanceof ExplorerVerifyError &&
      error.code === "not-confirmed"
    ) {
      show(
        "Sourcify is still checking. Reload the page later to see the result.",
      );
      return;
    }
    // Every other end leaves nothing to resume.
    localStorage.removeItem(PENDING_KEY);
    if (error instanceof ExplorerVerifyError) {
      show(`${error.code}: ${error.hint}`);
      return;
    }
    throw error;
  }
}

// Runs the module once on the sample. In the page, call it from a button.
const { validateInput } = await import("explorer-verify");
const sample = await import("./greeter-sepolia.json", {
  with: { type: "json" },
});
await verifyOnSourcify(validateInput(sample.default), console.log);
```

For the sample, Sourcify already holds the contract, so `verify()` submits nothing:

```text
already-verified (exact) https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

For a contract that Sourcify does not hold yet, the page shows the handle, then the result:

```text
Submitted. Handle: ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718
verified (exact) https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

`explorerUrl` is the contract's page on Sourcify. The call has a time budget of 120 seconds by
default (`timeoutMs`); see [verify()](../reference/verify.md#options).

## Step 4: Show the handle

The handle is the one-line form of the job: backend, chain, address and job id. It holds no key
and no URL, so it is safe to display, store or paste into a support request.

`verify()` emits `verify.submitted` as soon as Sourcify accepts the source. The module saves the
handle in `localStorage` at that moment, before the first poll, so a reload at any later point can
find the job again.

## Step 5: Resume after a page reload

A reload, a closed tab or the time budget can end the page's wait while Sourcify still checks the
source. The job goes on. `checkStatus()` polls the saved job again and never submits. Save this
module as `src/resume.ts`:

```ts [src/resume.ts]
import {
  ExplorerVerifyError,
  checkStatus,
  tryParseHandle,
} from "explorer-verify";

const PENDING_KEY = "greeter-verification";

/**
 * Polls the job whose handle a previous page load saved, if any. Never submits.
 */
export async function resumeVerification(
  show: (line: string) => void,
): Promise<void> {
  const stored = localStorage.getItem(PENDING_KEY);
  if (stored === null) {
    return;
  }
  // A value that is not a handle, such as one another version of the page
  // wrote, is dropped.
  const handle = tryParseHandle(stored);
  if (handle === undefined) {
    localStorage.removeItem(PENDING_KEY);
    show("The saved handle is not valid. It was removed.");
    return;
  }
  show(`Resuming ${stored}`);
  try {
    const result = await checkStatus(handle, { timeoutMs: 60_000 });
    localStorage.removeItem(PENDING_KEY);
    show(result.status);
  } catch (error) {
    if (
      error instanceof ExplorerVerifyError &&
      error.code === "not-confirmed"
    ) {
      show("Still checking. The handle stays saved for the next load.");
      return;
    }
    localStorage.removeItem(PENDING_KEY);
    throw error;
  }
}

await resumeVerification(console.log);
```

After a reload, with the job verified, it prints:

```text
Resuming ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718
verified
```

With no saved handle, it prints nothing and sends nothing. `checkStatus()` resolves the route from
the handle's chain; the handle never chooses a host. See [checkStatus()](../reference/check-status.md).

In the page's entry module, call `resumeVerification(show)` when the page loads, and
`verifyOnSourcify(input, show)` when the user clicks the verify button. The finished dapp of the
[next tutorial](deploy-and-verify-from-a-dapp.md) does both, in
[`examples/dapp/src/main.ts`](../../../examples/dapp/src/main.ts).

## Step 6: Read the result

`verify()` and `checkStatus()` return one of three results:

| `status`           | What to tell the user                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| `verified`         | The source is now public on Sourcify. Link `explorerUrl`                   |
| `already-verified` | Sourcify had the source already; nothing was submitted. Link the page      |
| `failed`           | Sourcify rejected the source. Show `reason`. The fix is in the build files |

`failed` usually means the compiled code differs from the deployed code, so a retry gives the same
answer. `match` is `exact` when the metadata hash matches too, and `partial` when only the code
matches. [Match types](../explanation/match-types.md) explains the difference.

## Step 7: Handle the errors

Every other end is an `ExplorerVerifyError`. Its `hint` says what to do next, and `retryable` says
whether trying again may help. The codes a dapp meets most often:

| Code                                                                            | What it means for the user                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`not-confirmed`](../reference/errors/not-confirmed.md)                         | Sourcify did not finish in time. Resume with `checkStatus()`         |
| [`invalid-input`](../reference/errors/invalid-input.md)                         | A field of the input is malformed. Nothing was sent                  |
| [`unsupported-chain`](../reference/errors/unsupported-chain.md)                 | The routing table does not list the chain                            |
| [`in-progress`](../reference/errors/in-progress.md)                             | Another submission of the contract is being checked. Retry later     |
| [`network`](../reference/errors/network.md)                                     | No answer from Sourcify. Check the connection and retry              |
| [`rate-limited`](../reference/errors/rate-limited.md)                           | Sourcify asked to slow down. Retry later                             |
| [`timeout`](../reference/errors/timeout.md)                                     | Time ran out before Sourcify accepted the source. Retry              |
| [`job-not-found`](../reference/errors/job-not-found.md)                         | Sourcify no longer knows the job. Call `verify()` again              |
| [`verification-inconclusive`](../reference/errors/verification-inconclusive.md) | The job ended without a verdict. Call `verify()` again later         |
| [`unknown-state`](../reference/errors/unknown-state.md)                         | Sourcify reported a state the library cannot classify. Check by hand |

[Errors](../reference/errors/index.md) lists every code, with its cause and fix.

## Next steps

- [Deploy a contract from a dapp and verify it](deploy-and-verify-from-a-dapp.md): deploy from the
  user's wallet, then verify on Sourcify and on Etherscan through your server.
- [Verify from a browser](../guides/verify-from-a-browser.md): load the library on first use,
  a CDN import map, and the explorers a page can call.
- [Bundle size](../advanced/bundle-size.md): what the library adds to a page, by client.
- [checkStatus()](../reference/check-status.md): the handle and every way to resume.
