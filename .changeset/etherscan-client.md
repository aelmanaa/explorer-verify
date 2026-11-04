---
"explorer-verify": patch
---

Add the Etherscan API v2 client. `verify()` and `checkStatus()` use it for `route.backend` `etherscan-v2`. Every request is a form-encoded POST to `https://api.etherscan.io/v2/api?chainid=<id>`, with the key in the body and never in the URL.

The routing table has no Etherscan rows yet, so a key in `apiKeys` alone does not reach Etherscan; it will once the table lists Etherscan for the chain. Until then, name the route:

- On a server: `route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api", apiKey }`.
- From a browser: `route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" }` and a `fetch` that sends the requests to your `createVerifyHandler`, which adds the key.

Etherscan answers almost everything with HTTP 200 and puts the meaning in its `result` text. The client maps each known text to an outcome or a typed error. A text it does not know throws: it never reads as success, as "not verified" or as `failed`.

- `Max calls per sec rate limit reached` is retried with backoff, as a 429 is, and emits `verify.retry` with `reason` `rate-limited`. A daily limit throws `quota-exceeded` at once.
- `Contract source code already verified` and `Already Verified` give `already-verified`.
- `Unable to locate ContractCode at …` sends the submit again every `pollIntervalMs`, at most 10 times, with a `verify.retry` event whose `reason` is the new value `not-indexed`. The error at the end says to check the chain id and the address.
- `Fail - Unable to verify` is checked with one lookup before the call reports `failed`.
- A lookup with a non-empty `SimilarMatch` gives `partial`.

`event.schema.json` adds `not-indexed` to the `verify.retry` reasons. The not-confirmed message now says whether the last lookup failed or found no match. The new reference page `docs/user/reference/etherscan.md` lists the requests and how each answer is read.

[#61](https://github.com/aelmanaa/explorer-verify/issues/61)
