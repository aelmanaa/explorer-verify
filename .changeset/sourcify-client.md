---
"explorer-verify": patch
---

Add the Sourcify API v2 client, the first backend. It looks a contract up, submits the source and polls the job. Each Sourcify answer becomes a match, a result or a typed error; an answer the client does not recognise throws and is never read as "not verified" or as success. A submit that got no clear answer is not sent again blindly: the client looks the contract up first. A `failed` reason is redacted with the call's keys and cut to 300 characters. `verify()` and `checkStatus()` will call the client; they are not in this release.

Add the error code `verification-inconclusive`: the explorer finished the job without a verdict, for example with an internal error or before it saw a new contract. Call `verify()` again; it looks the contract up first. The error is retryable, exits with code 4 and carries no handle.

The new reference page `docs/reference/sourcify.md` lists the requests, how each answer is read, and Sourcify behaviour to know: lookups cached for an hour, and submits forwarded to other explorers.

[#16](https://github.com/aelmanaa/explorer-verify/issues/16)
