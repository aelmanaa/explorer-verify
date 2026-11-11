---
"@explorer-verify/cli": patch
---

When Blockscout answers each submit without a job id, the CLI now prints "If the contract was deployed moments ago, try again later." Before, it printed the general `unexpected-response` hint. A `timeout` always gets the CLI's own hint, which names `--timeout`.

[#326](https://github.com/aelmanaa/explorer-verify/issues/326)
