# 0041: Blockscout's hosted API is the backend `blockscout-hosted`, with a key bound to `api.blockscout.com`

Status: Accepted (2026-11-05). Amends the key list and the placement of
[decision 0016](0016-api-keys-bound-to-hosts.md). Composes with the Blockscout entries of
[decision 0038](0038-blockscout-rows.md) and the table loading of
[decision 0040](0040-routing-table-loads-on-demand.md).

Research: [Blockscout's hosted API with a key](../research/2026-11-05-blockscout-hosted-api.md),
[the deprecation watch](../research/2026-11-05-blockscout-deprecation-watch.md),
[the Blockscout client](../research/2026-11-04-blockscout-client.md).

## Context

The Blockscout client reaches one instance at a time, keyless. Blockscout's docs now say the
per-instance API "has been deprecated", with no removal date, and point to a hosted API at
`api.blockscout.com` that serves many chains behind one key. Issue
[#96](https://github.com/aelmanaa/explorer-verify/issues/96) asks for that API, with the questions
decision 0016 answered for Etherscan: which host may receive the key, where in the request it
goes, and how the API's answers about the key map to errors.

Decision 0016 binds a key from `apiKeys` to the host the routing table lists for the route's
backend. For `blockscout` that host is an instance, so a hosted-API key under `apiKeys.blockscout`
would need a special case to keep it off every instance.

The live run of 2026-11-05 found:

- `https://api.blockscout.com/<chainId>/api` takes the instance's requests and gives the
  instance's answers, the REST lookup under `/api/v2/` included. The verification texts, from
  `Smart-contract already verified.` to `Pass - Verified`, are the same.
- The API reads a key from the `authorization` header, with or without `Bearer`, from an `apikey`
  form field, and from an `apikey` query parameter.
- No key: HTTP 402. A made-up key: HTTP 401. A free-plan key on Base Sepolia: HTTP 402 naming the
  plans that cover it. A chain it does not serve: HTTP 404 `Network not supported`.
- A preflight and a keyed GET from a browser origin get no `access-control-allow-origin`.
- A contract verified through the hosted API shows as verified on the chain's instance.

## Decision

### A separate backend name

- `BACKEND_NAMES` gains `blockscout-hosted`, after `blockscout`. Its client is the instance
  client's code with the hosted route, as `etherscan-compatible` reuses the Etherscan v2 code. Both
  clients live in `backends/blockscout.ts`, so they share one chunk; `linkProxy()` uses the same
  proxy-link code for both.
- A handle, a result and an event name the backend, so `ev1:blockscout-hosted:<chainId>:…` resumes
  on the hosted API with `checkStatus()` and the CLI's `status`, and a result says where the
  contract was verified.
- `apiKeys["blockscout-hosted"]` is a key like `apiKeys["etherscan-v2"]`: the backend needs a key
  for every request, and its key goes only to its one host. `apiKeys.blockscout` stays refused.
  `route.apiKey` works for `blockscout-hosted` next to `route.apiUrl`, as for `etherscan-v2`.
- The CLI reads `BLOCKSCOUT_API_KEY`, from the environment, a key file or stdin, into
  `apiKeys["blockscout-hosted"]`, and takes `--backend blockscout-hosted` like any other name,
  repeated `--backend` and `--input-json` included.

### Routing

- `route.backend: "blockscout-hosted"` without `apiUrl` resolves to
  `https://api.blockscout.com/<chainId>/api` for any chain. No row lists the backend. The table
  still loads: the result's `explorerUrl` is the page of the instance the row lists, when it lists
  one, because a contract verified through the hosted API shows there.
- The routing table never picks it: a call without `route.backend` goes where it went before, and
  instances stay the backend that `route.backend: "blockscout"` and decision 0038's entries name.
- `verifyEach()` with `backends: "all"` leaves it out, with or without its key. A contract verified
  through the hosted API shows on the instance, so the two entries would verify the same record
  twice. A caller who wants both names them in a list.
- `route.backend: "blockscout"` with a `route.apiUrl` on `api.blockscout.com` throws
  `invalid-input` naming `route.apiUrl`, with a hint that names `blockscout-hosted`: the instance
  client sends no key and reads no key answer, so that call could only fail later.

### Placement: the `authorization` header

`withKey` puts the key in `authorization` as `Bearer <key>` on every request of
`blockscout-hosted`. The lookup is a GET, so a form body cannot carry it; the query would put it in
a URL (R-SEC-1). `Bearer` is the form the developer portal documents.

### Answers

Only the `blockscout-hosted` client reads these, before its own mapping. The instance client keeps
its mapping: an instance's 401, 402 or 404 is `unexpected-response`, as before this change.

| Answer                                                 | Code                |
| ------------------------------------------------------ | ------------------- |
| HTTP 401                                               | `api-key-rejected`  |
| HTTP 402 to a request that carried a key               | `api-key-rejected`  |
| HTTP 402 `... requires one of the following plans ...` | `api-key-rejected`  |
| Any other HTTP 402                                     | `missing-api-key`   |
| HTTP 404 `Network not supported`                       | `unsupported-chain` |

A 402 to a keyed request means the key was refused, or its plan or credits do not cover the
request; Blockscout's docs say spent credits reject requests but give no text, so no answer maps to
`quota-exceeded`. A 402 to a request without a key, as through an injected `fetch` to a server
that should add one, is `missing-api-key`. A 429 is retried by the HTTP layer, as for an instance.
The errors hold the backend only.

## Alternatives considered

- `route.hostedApi: true` on the `blockscout` backend, with `apiKeys.blockscout`. This was the
  first version of this change. Rejected: the handle and the result said `blockscout`, so
  `checkStatus()` resumed a hosted job on the instance; `apiKeys.blockscout` needed a host rule of
  its own, and without `hostedApi` the key was accepted and silently unused; `verifyEach()`
  entries and the CLI's `--input-json` needed a new field; and the instance client read the hosted
  API's key answers too.
- Switch to the hosted API whenever its key is set. Rejected: a key read from the environment would
  move every Blockscout call off its instance, and a free-plan key is refused on chains such as
  Base Sepolia, where the keyless instance works.
- Rows for the hosted API in the routing table. Rejected for now: the free plan does not cover
  every chain, the API's chain list was not probed, and the per-instance API still answers on every
  instance the deprecation watch samples. The watch of
  [#198](https://github.com/aelmanaa/explorer-verify/issues/198) says when to revisit this.
- The documented `/v2/api?chain_id=<id>` form. Rejected: the lookup needs the REST path, which only
  the `/<chainId>/api` form has, and one form for every request keeps one origin and one base.
- The key in the form body. Rejected: the lookup is a GET.

## Consequences

- `BACKEND_NAMES`, the backend lists of the schemas and the CLI's `--backend` gain
  `blockscout-hosted`. A caller that switches over every backend name needs one more case.
- R-BE-3 states the hosted backend. The API keys page lists `api.blockscout.com` and the header.
- The CLI reads `BLOCKSCOUT_API_KEY`, and its help lists each key variable's one host.
- The server handler is unchanged: it forwards Etherscan only, and the hosted API sends no CORS
  headers, so a browser cannot use `blockscout-hosted`. No Blockscout terms on exposing a key were
  found.
- Proxy linking on the hosted API sends the same requests with the key, but was not run live.
- Sizes, measured with `pnpm run size` (esbuild 0.28.2, Node.js 24.21.0 zlib) on 2026-11-05:
  "Before" is main at commit d82957d, whose package sources match 68867bc, where they were
  measured; "After" is that commit with this change. No ceiling changes.

| Entry or chunk           | Before | After  | Ceiling |
| ------------------------ | ------ | ------ | ------- |
| `verify`                 | 14,862 | 15,014 | 16,334  |
| `verify (one file)`      | 25,054 | 25,721 | 25,996  |
| `checkStatus`            | 12,691 | 12,835 | 14,076  |
| `verifyEach`             | 16,483 | 16,640 | 18,316  |
| `linkProxy`              | 11,763 | 11,901 | 13,512  |
| `index`                  | 27,074 | 27,244 | 31,510  |
| chunk `blockscout`       | 2,946  | 3,408  | 3,520   |
| chunk `proxy-blockscout` | 3,975  | 4,473  | 4,769   |
