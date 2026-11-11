---
"explorer-verify": patch
---

The `duplicate-submission` reason of `verify.retry` and `proxy.retry` is now marked reserved in the type, in `event.schema.json` and in the logging reference. No client emits it: Sourcify's answer to a duplicate request ends the call with `in-progress`, not a retry. The value stays, so code that switches on it still compiles.

[#353](https://github.com/aelmanaa/explorer-verify/issues/353)
