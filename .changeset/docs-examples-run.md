---
"explorer-verify": patch
---

Every TypeScript example in the packaged docs now compiles and runs in the tests, and each example that prints shows its output. Fixed examples: the errors page and the abort example in `verify()` now import `verify`; the npm package guide names the Hardhat 3 build-info file with its full id; the Hardhat guide no longer calls `verify()` at the end of its first example, as in the other guides; the server handler's first example says that `deployerAddress` stands for your own address, prints the answer, and shows what `logger: console` prints; the linked-libraries examples in `verify()` and the Hardhat guide now run on their own and show their output. Issue: https://github.com/aelmanaa/explorer-verify/issues/83
