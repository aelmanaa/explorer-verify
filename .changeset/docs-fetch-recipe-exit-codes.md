---
"explorer-verify": patch
---

Docs: "Verify from Node.js" lists what explorer-verify sends on each request and adds a `fetch` that sets a `User-Agent` and sends requests through undici's `ProxyAgent`. The Etherscan reference says that a `Fail - Unable to verify` status costs one more lookup. Error pages give the fix under "How to fix" without a repeated "Fix:" label. CLI examples state the exit code in the line after the command, so the copy button copies only the command.
