---
"explorer-verify": patch
---

Right after a deployment, Blockscout can answer a submit with no job id, and the client submits again. When the time budget runs out during that loop, including the lookup or the new submit after an empty answer, the `timeout` error now holds `details.reason` `empty-submit`. `hintFor(error, "user")` then tells the end user that the explorer did not start the verification, and to check the contract's page and try again in a minute. It gives the same hint for the error's JSON form. Any other `timeout` has no `reason` and keeps its hint.

[#349](https://github.com/aelmanaa/explorer-verify/issues/349)
