---
"explorer-verify": minor
---

`verify()` verifies Vyper contracts (`kind: "vyper"`) on Etherscan v2, on every chain it serves, directly and through the server handler. The submit sends `codeformat=vyper-json`, `compilerversion=vyper:0.4.3` and `optimizationUsed`, which Etherscan requires for Vyper. Sourcify and Etherscan v2 now both verify Vyper, and the routing table picks between them as for solc: Etherscan v2 where it comes first in the chain's row and its key is set, else Sourcify. Vyper 0.3.x input with `interfaces`, which Sourcify refuses, goes to Etherscan v2. Every other backend still refuses Vyper input with `unsupported-compiler` before any request.

`validateInput` now refuses a Vyper `settings.optimize` other than `"none"`, `"gas"`, `"codesize"`, `true`, `false` or `null`, with `invalid-input` on `compiler.input.settings.optimize`.

`createVerifyHandler` now forwards `optimizationUsed` (`0` or `1`) and accepts a `compilerversion` of the form `vyper:0.4.3`, each part `0` or 1 to 4 digits without a leading zero.

What should I do? To verify Vyper through your own server handler, update the handler to this release with the client: an older handler answers a Vyper submit with `bad-request`. Fix a Vyper `settings.optimize` that `validateInput` now refuses.

Issue: https://github.com/aelmanaa/explorer-verify/issues/424
