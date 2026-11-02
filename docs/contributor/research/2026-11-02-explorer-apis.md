# 2026-11-02: Explorer verification APIs

Audience: whoever implements a backend client. Checked on 2026-11-02 from the explorers' public
docs and with live requests. Re-check an API before building its client; record changes here as a
new dated note.

## Browser reachability (live, 2026-11-02)

Each request was sent with an `Origin` header from an unrelated site:

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
- Constructor-argument spelling: the docs say `constructorArguments`. hardhat-verify v2 sent only the
  misspelled `constructorArguements`, v3 sends only the correct one, and Foundry sends both. Both
  prior-art implementations send both spellings (bare hex, no `0x`, omitted for a constructor
  without arguments). Keep that.
- Success: `{ "status": "1", "message": "OK", "result": "<guid>" }`. On failure `message` is a
  generic `NOTOK` and the reason is in `result` (for example `Unable to locate ContractCode at …`,
  `Invalid API Key`, `Missing/unsupported chainid`).
- Poll: `GET ...&action=checkverifystatus&guid=<guid>`. Result strings the prior art classifies:
  `Pending in queue`, `Pass - Verified`, and a `Fail - ` prefix (as `Fail - Unable to verify`). An
  "already verified" answer is matched separately. Any other string is unrecognised and must not
  count as success.
- Key handling: a valid key with a trailing `"` is still accepted, an invalid key returns
  `Invalid API Key (#err2)`, a missing key `Missing/Invalid API Key` (live, 2026-11-02).
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
- Similarity: `POST /v2/verify/similarity/...`; the monitor also runs it after contract creation on
  monitored chains.
- No key. Rate limits and terms: not documented on that page (open question).

## Blockscout

Source: [Blockscout verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api).

- Hosted multichain: `POST https://api.blockscout.com/v2/api?chain_id=<id>&module=contract&action=verifysourcecode&apikey=<key>`,
  `multipart/form-data` with `codeformat=solidity-standard-json-input`, `contractaddress`,
  `sourceCode`, `contractname`, `compilerversion`, optional `constructorArguments`,
  `autodetectConstructorArguments`, `licenseType`, `libraryname1`/`libraryaddress1`. Returns a guid;
  poll with `checkverifystatus`. Free keys at dev.blockscout.com.
- Per instance: each Blockscout instance serves the Etherscan-compatible `/api` (no `chainid`) and a
  REST `POST /api/v2/smart-contracts/{address}/verification/via/standard-input`. The prior art used
  the per-instance `/api` without a key.
- Partial match is expected for bytecode without a metadata hash (`bytecode_hash = "none"`).

## Automatic matching (no submission needed)

- Etherscan Similar Match: a contract whose creation bytecode matches an already-verified one is
  verified automatically, without checking constructor arguments, and shows a yellow badge. It
  cannot be upgraded to Exact Match ([Etherscan](https://info.etherscan.com/types-of-contract-verification/)).
- Blockscout's Ethereum Bytecode Database matches on the bytecode without its metadata part
  ([docs](https://docs.blockscout.com/about/features/ethereum-bytecode-database-microservice)).
- Sourcify similarity verification uses the first 75 bytes of the runtime bytecode to find
  candidates ([docs](https://docs.sourcify.dev/docs/similarity-verification/)).

Consequence for the flow: check first (R-FLOW-1); a contract can already be verified before any
submission.
