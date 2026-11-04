---
"explorer-verify": patch
---

Add the Blockscout client for single-chain instances. `verify()` and `checkStatus()` use it for `route.backend` `blockscout`. It sends no API key: a key in `route.apiKey` or `apiKeys.blockscout` still throws `invalid-input`.

The routing table has no Blockscout rows yet. Name the instance's API, which must end in `/api`:

```ts
await verify(input, {
  route: { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
});
```

The lookup reads the instance's REST API, `GET /api/v2/smart-contracts/{address}`: `is_fully_verified` gives `exact` and `is_partially_verified` gives `partial`. The submit and the status request are form-encoded POSTs to `/api`, with `verifysourcecode` and `checkverifystatus`.

- A build without a metadata hash gives `verified` with `partial`, never `failed`.
- `Unknown UID` throws `job-not-found` after the flow's lookup, although Blockscout sends it with `status` `"1"`.
- An empty answer to a submit, which can come right after a deployment, is followed by a lookup and a new submit: at most 4 submits, within 30 seconds of the first. Each wait emits `verify.retry` with the new `reason` `empty-submit`.
- `Address is not a smart-contract` throws `invalid-input` naming `address`.
- A text the client does not know throws. It never reads as success, as "not verified" or as `failed`.

`event.schema.json` adds `empty-submit` to the `verify.retry` reasons. A routing-table entry for `blockscout` holds the instance's host as `instance`. The new reference page `docs/user/reference/blockscout.md` lists the requests and how each answer is read.

[#92](https://github.com/aelmanaa/explorer-verify/issues/92)
