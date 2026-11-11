---
"explorer-verify": minor
---

Breaking: through a server handler (`handlerUrl`), the handler's 503 `address-not-indexed` now throws `not-indexed` instead of `unexpected-response`. The handler sends it when its `deployers` option is set and Etherscan has no creation record for the address yet. The client still retries as `Retry-After` asks. The error then has the same code, exit code 4 and end-user hint as a direct call. `details.submits` counts HTTP attempts, unlike a direct call, which counts answers: the attempts of the refused request when it was the submit, `0` when it was the lookup or another request. `details.elapsedMs` runs from the first attempt of the refused request to its last answer. `linkProxy()` through the handler can throw it too. Its hint says to call again in a minute, since `indexWaitMs` has no effect there. Code that matched `unexpected-response` for this refusal must match `not-indexed`. The handler's answer does not change.

[#354](https://github.com/aelmanaa/explorer-verify/issues/354)
