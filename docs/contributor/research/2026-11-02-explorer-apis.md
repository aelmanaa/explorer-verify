# 2026-11-02: Explorer verification APIs

Audience: whoever implements a backend client. Checked on 2026-11-02 from the explorers' public
docs and with live requests. Re-check an API before building its client. Record API changes in a
new dated note; fix a mistake in this note with an entry under [Corrections](#corrections). Each
claim names its source; the links and the local runs are listed under [Sources](#sources).

## Browser reachability (live, 2026-11-02)

Each request was sent with curl 8.7.1 on 2026-11-02, with an `Origin` header from an unrelated
site:

| Endpoint                                              | Request                                                             | `access-control-allow-origin`                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `https://api.etherscan.io/v2/api`                     | GET `getabi`, and an OPTIONS preflight for POST with `content-type` | `*` (preflight also allows `GET, POST, OPTIONS` and `Content-Type`) |
| `https://sourcify.dev/server/v2/contract/1/<address>` | GET                                                                 | `*`                                                                 |
| `https://eth.blockscout.com/api`                      | GET `getabi`                                                        | `*`                                                                 |

A browser can call all three directly. Only the API key decides whether it should (decision 0003).

## Etherscan API v2

Source: [verifysourcecode](https://docs.etherscan.io/api-reference/endpoint/verifysourcecode).

- Submit: `POST https://api.etherscan.io/v2/api?chainid=<id>&module=contract&action=verifysourcecode&apikey=<key>`,
  body `application/x-www-form-urlencoded`.
- Body fields: `contractaddress`, `sourceCode` (the Standard JSON string), `contractname`
  (`path:Name`), `compilerversion` (`v0.8.24+commit.e11b9ed9`), `codeformat=solidity-standard-json-input`,
  optional `constructorArguments` and `licenseType`.
- Constructor-argument spelling: Etherscan's docs name the field `constructorArguments`. Both
  [prior-art](../prior-art.md) implementations send both spellings, `constructorArguments` and
  `constructorArguements` (read in `etherscan.ts` at ccip-tools-ts commits `1cecb266` and
  `ac4340e7` on 2026-11-02). Implementation B sends bare hex, no `0x`, and omits the field for a
  constructor without arguments. Keep that.
- Success: `{ "status": "1", "message": "OK", "result": "<guid>" }` (Etherscan docs). On failure
  `message` is a generic `NOTOK` and the reason is in `result`. Seen live with curl 8.7.1 on
  2026-11-02: `Unable to locate ContractCode at 0x…` for a submit to an address with no code,
  `Missing or unsupported chainid parameter (required for v2 api), …` for an unknown `chainid`.
- Poll: `GET ...&action=checkverifystatus&guid=<guid>`
  ([docs](https://docs.etherscan.io/api-reference/endpoint/checkverifystatus), which show
  `Pass - Verified`). Result strings the prior art classifies (`verify.ts` at `1cecb266`,
  `etherscan.ts` at `ac4340e7`): `Pending in queue`, `Pass - Verified`, and
  `Fail - Unable to verify`. The "already verified" answers, `Contract source code already verified`
  and `Already Verified`, are matched separately. Any other string is unrecognised and must not
  count as success.
- Key handling, live with curl 8.7.1 on 2026-11-02: a valid key with a trailing `"` is still
  accepted, an invalid key returns `Invalid API Key (#err2)`, a missing key
  `Missing/Invalid API Key`.
- Rate limits ([docs](https://docs.etherscan.io/resources/rate-limits)): Free 3/s and 100,000/day on
  selected chains, Lite 5/s, Standard 10/s, Advanced 20/s and 500,000/day, Professional 30/s.

## Sourcify API v2

Source: [Sourcify API docs](https://docs.sourcify.dev/docs/api/). The v1 API was switched off on
2026-07-07.

- Submit: `POST https://sourcify.dev/server/v2/verify/{chainId}/{address}` with JSON
  `{ stdJsonInput, compilerVersion, contractIdentifier, creationTransactionHash? }`. Returns a
  `verificationId`.
- Poll: `GET /v2/verify/{verificationId}`.
- Lookup: `GET /v2/contract/{chainId}/{address}?fields=all`. Match fields are in the OpenAPI spec at
  `https://sourcify.dev/server/api-docs/swagger.json`; read it before mapping `exact`/`partial`.
- Similarity: `POST /v2/verify/similarity/{chainId}/{address}` (in the OpenAPI spec, version
  2.1.0); the monitor also schedules it after contract creation on monitored chains
  ([docs](https://docs.sourcify.dev/docs/similarity-verification/)).
- No key. Rate limits and terms: not found on that page on 2026-11-02 (open question).

## Languages other than Solidity

- Sourcify: the `language` field of the Standard JSON input accepts `Solidity`, `Vyper` and `Fe`
  (enum in the OpenAPI spec, version 2.1.0).
- Blockscout hosted API: `action=verify_vyper_contract` takes `addressHash`, `name`,
  `compilerVersion`, `contractSourceCode` and an optional `constructorArguments`. The
  [docs](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api)
  confirm only single-file Vyper on this route, and point to the per-instance API for Vyper
  Standard JSON.
- Etherscan: the `codeformat` values in the verifysourcecode docs are `solidity-single-file` and
  `solidity-standard-json-input`; no Vyper value is listed there.

## Blockscout

Source: [Blockscout verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api).

- Hosted multichain: `POST https://api.blockscout.com/v2/api?chain_id=<id>&module=contract&action=verifysourcecode&apikey=<key>`,
  form fields (the docs' examples send multipart form data): `codeformat=solidity-standard-json-input`, `contractaddress`,
  `sourceCode`, `contractname`, `compilerversion`, optional `constructorArguments`,
  `autodetectConstructorArguments`, `licenseType`, `libraryname1`/`libraryaddress1`. Returns a guid;
  poll with `checkverifystatus`. Free keys at dev.blockscout.com.
- Per instance: each Blockscout instance serves the Etherscan-compatible `/api` (no `chainid`; the
  docs say the same actions work against an instance's own API) and a REST
  `POST /api/v2/smart-contracts/{address}/verification/via/standard-input` (route in the
  [Blockscout router](https://github.com/blockscout/blockscout/blob/bf2098dd748c5da4b147fad8bff9d63b0d5aae66/apps/block_scout_web/lib/block_scout_web/routers/smart_contracts_api_v2_router.ex)).
  The prior art used the per-instance `/api` without a key ([prior art](../prior-art.md)).
- Partial match is expected for bytecode without a metadata hash (`bytecode_hash = "none"`). The
  prior art saw it in live runs
  ([prior art](../prior-art.md#behaviour-both-implementations-learned)). Sourcify's docs define an
  exact match as one where the metadata hashes match
  ([docs](https://docs.sourcify.dev/docs/exact-match-vs-match/)).

## Automatic matching (no submission needed)

- Etherscan Similar Match: a contract whose creation bytecode matches an already-verified one is
  verified automatically, without checking constructor arguments, and shows a yellow badge. The page
  says no tool upgrades it to Exact Match for now, and that re-verification is enabled for
  whitelisted users ([Etherscan](https://info.etherscan.com/types-of-contract-verification/)).
- Blockscout's Ethereum Bytecode Database matches only on the functionally significant parts of the
  bytecode, without its metadata part ([docs](https://docs.blockscout.com/about/features/ethereum-bytecode-database-microservice)).
- Sourcify similarity verification uses the first 75 bytes of the runtime bytecode to find
  candidates ([docs](https://docs.sourcify.dev/docs/similarity-verification/)).

Consequence for the flow: check first (R-FLOW-1); a contract can already be verified before any
submission.

## Sources

Read on 2026-11-02:

- Etherscan: [verifysourcecode](https://docs.etherscan.io/api-reference/endpoint/verifysourcecode),
  [checkverifystatus](https://docs.etherscan.io/api-reference/endpoint/checkverifystatus),
  [rate limits](https://docs.etherscan.io/resources/rate-limits),
  [types of contract verification](https://info.etherscan.com/types-of-contract-verification/).
- Sourcify: [API docs](https://docs.sourcify.dev/docs/api/),
  [OpenAPI spec](https://sourcify.dev/server/api-docs/swagger.json) (version 2.1.0),
  [similarity verification](https://docs.sourcify.dev/docs/similarity-verification/),
  [exact match and match](https://docs.sourcify.dev/docs/exact-match-vs-match/).
- Blockscout:
  [verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api),
  [Ethereum Bytecode Database](https://docs.blockscout.com/about/features/ethereum-bytecode-database-microservice),
  [API v2 router at commit `bf2098dd`](https://github.com/blockscout/blockscout/blob/bf2098dd748c5da4b147fad8bff9d63b0d5aae66/apps/block_scout_web/lib/block_scout_web/routers/smart_contracts_api_v2_router.ex).
- Prior art: ccip-tools-ts commits
  [`1cecb266`](https://github.com/smartcontractkit/ccip-tools-ts/commit/1cecb266) and
  [`ac4340e7`](https://github.com/smartcontractkit/ccip-tools-ts/commit/ac4340e7), described in
  [prior-art.md](../prior-art.md).

Local runs, curl 8.7.1, 2026-11-02:

- The `access-control-allow-origin` checks in the table above.
- Etherscan v2 `getabi` with an invalid key, a missing key, a valid key with a trailing `"`, and an
  unknown `chainid`; a `verifysourcecode` submit for an address with no code on Sepolia.

## Corrections

- 2026-11-02: added the source of each claim and the `## Sources` section; named curl 8.7.1 for
  the live checks; replaced the `chainid` error example with the exact text seen live; named the
  similarity endpoint path; changed the Similar Match sentence to what the Etherscan page says (no
  tool upgrades it to Exact Match for now; re-verification is enabled for whitelisted users);
  added the section on languages other than Solidity.
