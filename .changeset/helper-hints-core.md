---
"explorer-verify": patch
---

When Blockscout, on an instance or through `blockscout-hosted`, answers each submit without a job id, the hint no longer names `verify()`. It reads "If the contract was deployed moments ago, try again later." The `unexpected-response` error that ends this loop now holds the number of submits sent in `details.attempts`. For this error, `hintFor(error, "user")` says that the explorer did not start the verification, and asks the user to check the contract's page on the explorer, then to try again in a minute. Before, it gave the general hint for an answer that could not be read. A job status or proxy-link answer of the same shape still gets the general hint.

[#326](https://github.com/aelmanaa/explorer-verify/issues/326)
