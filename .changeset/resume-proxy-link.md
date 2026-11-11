---
"explorer-verify": patch
---

`linkProxy()` can resume a pending proxy link without sending a new link request. The `proxy-link-pending` error now carries `details.jobId`, the job id the explorer gave for the link request, with API keys removed. Pass it back as `resumeJobId` with the same target and route: the call sends only `checkproxyverification`, checks at once and then every `pollIntervalMs`. This also works through `explorer-verify/core` and through the server handler with `allowProxyLink: true`.

A `resumeJobId` that is not of the form the backend gives for the proxy throws `invalid-input` before any request, and so does any `resumeJobId` on Sourcify, which starts no link job. A job id the explorer no longer knows throws `proxy-link-unknown-state`. The default hint of `proxy-link-pending` names the new option.

[#296](https://github.com/aelmanaa/explorer-verify/issues/296)
