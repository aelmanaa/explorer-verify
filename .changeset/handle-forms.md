---
"explorer-verify": minor
---

Breaking: `formatHandle` now returns `HandleString`, the template literal type of the one-line form `ev1:<backend>:<chainId>:<address>:<jobId>`, and the `verify.submitted` event's `handle`, `ErrorJson.handle` and each `ErrorJson.handles[].handle` use the same type. The one-line form is now the one documented form to store: every example stores `formatHandle(handle)` instead of `JSON.stringify(handle)`, which `parseHandle` and `checkStatus` do not read. For a value in neither form, the error message names the handle object and the one-line form, and the hint of every handle error names both. The new `tryParseHandle` reads the same two forms and returns `undefined` instead of throwing, and the new `isHandleString` tells whether a value is a valid one-line handle and narrows it to `HandleString`. Neither loads the error code: `tryParseHandle` alone is about 2.2 KB minified. Issue: https://github.com/aelmanaa/explorer-verify/issues/218

What should I do? Store `formatHandle(handle)` and pass the stored text to `checkStatus`. A value typed `string` no longer fits `HandleString`: check it with `isHandleString`, or keep the variable typed `string`. Use `tryParseHandle` to check a stored value without catching an error.
