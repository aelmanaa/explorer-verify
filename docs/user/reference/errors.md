# Errors

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents handling errors from explorer-verify.

Every error the library throws is an `ExplorerVerifyError`, except on abort, where the call rejects
with `signal.reason` unchanged. Check `error.details.code` to read the data for that code. Each
error has:

| Field       | Contents                                                                              |
| ----------- | ------------------------------------------------------------------------------------- |
| `code`      | A stable code from the list below                                                     |
| `message`   | What went wrong                                                                       |
| `hint`      | What to do next                                                                       |
| `docsUrl`   | The code's entry on this page                                                         |
| `retryable` | `true` when the same call may succeed later without a change                          |
| `details`   | The code's data, such as the handle                                                   |
| `cause`     | The underlying error, when there is one. `toJSON()` and `JSON.stringify` leave it out |

`JSON.stringify(error)` prints `code`, `message`, `hint`, `docsUrl`, `retryable` and, when there is
one, the handle in its one-line form. It never prints `cause`, the stack or an API key.

```ts
import { ExplorerVerifyError } from "explorer-verify";

try {
  await verify(input);
} catch (error) {
  if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
    localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
  }
  throw error;
}
```

## invalid-input

Cause: the input failed validation, or a handle did not parse. A handle with a field it does not
know, such as `apiUrl`, is rejected: a handle never sets the host.

Fix: correct each field listed in `details.issues` (`field` and `message`), then call again. For a
handle, pass it exactly as `verify()` or a `not-confirmed` error returned it.

Retryable: no. Nothing was sent to an explorer.

## not-confirmed

Cause: the time budget (`timeoutMs`) ran out while the explorer was still verifying the contract.

Fix: store `details.handle` and pass it to `checkStatus()` later to continue polling. Raise
`timeoutMs` if this happens often.

Retryable: yes.
