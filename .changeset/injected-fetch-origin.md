---
"explorer-verify": patch
---

`verify()` reads the answer of a `fetch` you pass even when it comes from another URL than the explorer's, such as the server handler at `/api/verify` on the page's own origin. Before, every answer through the server handler ended with `unexpected-response`: "answered with a redirect, which is not followed". A 3xx, an opaque redirect or an answer marked `redirected` still ends the call with `unexpected-response`, from any `fetch`. With the default `fetch`, an answer from another origin than the request is still refused. Issue: https://github.com/aelmanaa/explorer-verify/issues/183
