---
"explorer-verify": patch
---

The package now ships an agent skill at `skills/explorer-verify/SKILL.md`. It shows how to build the input from build files or from Solidity metadata and sources, call `verify()`, store the handle, resume with `checkStatus()` instead of submitting again, and read the result, the error codes, the JSON envelope and the exit codes. It sets limits on retries, says when to stop and ask the person, and states the key and redirect rules. The tests run every example in the skill against the built package. Issue: https://github.com/aelmanaa/explorer-verify/issues/6
