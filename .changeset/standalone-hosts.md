---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

The routing table can now list a standalone Etherscan-compatible explorer for a chain, and lists one: Bitlayer (200901), at `https://api.btrscan.com/scan/api`. A call on 200901 goes there with no route option, and a verified result's `explorerUrl` is `https://www.btrscan.com/address/<address>#code`. Before, it threw `unsupported-chain`. The table has 326 rows and `schemaVersion` 3; schema 3 adds the `etherscan-compatible` entry, with `api` (the API's host and path), an optional `explorer` host and an optional `needsKey`.

`route.apiKey` with `route.backend` `etherscan-compatible` may now be set without `route.apiUrl` on a chain whose row lists a standalone explorer with `needsKey`. The key goes only to that explorer's host, in the form body. For an entry that takes no key, such as Bitlayer's, the call throws `invalid-input` naming `route.apiKey`, and on a chain whose row lists none it throws `unsupported-chain`, both before any request. `apiKeys["etherscan-compatible"]` still throws `invalid-input`. From the CLI, `--backend etherscan-compatible` with `--api-key-file` or `--api-key-stdin` and no `--api-url` follows the same rules.

`verifyEach()` with `backends: "all"` leaves out an entry with `needsKey` when no key is bound and the row lists another backend. `linkProxy()` throws `invalid-input` on `route.backend` for a standalone explorer from the table, before any request; with `route.apiUrl` it works as before.

A table entry with `needsKey: true` is skipped by a call without a key, and a call that reaches it without `route.apiKey` throws `missing-api-key` before any request, unless `fetch` is set. No entry in this release needs a key: Core (1116) and Kaia (8217) refused a keyless request and have no entry yet.

Behaviour change: the `etherscan-compatible` client sends a lookup or a status request without a key as a GET with its fields in the query, because Bitlayer refuses a lookup sent as a POST. With a key, it stays a form POST, so the key is never in a URL. A lookup answered with `"status":"1"` and an empty `result` list now means "not verified" for this client.

[#170](https://github.com/aelmanaa/explorer-verify/issues/170)
