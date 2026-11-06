# 0053: A `route.apiUrl` on Etherscan's own API takes `apiKeys["etherscan-v2"]`

Status: Accepted (2026-11-06). Amends the key rule of
[decision 0023](0023-routing-table-size-measured-apart.md), section "Keys", which sent no key from
`apiKeys` to any `route.apiUrl`, even one on the routing table's own host.

Research: none (maintainer choice).

## Context

Issue [#244](https://github.com/aelmanaa/explorer-verify/issues/244). With
`apiKeys["etherscan-v2"]` set and `route: { backend: "etherscan-v2", apiUrl:
"https://api.etherscan.io/v2/api" }`, `verify()` threw `missing-api-key` with the message
`apiKeys.etherscan-v2 is sent only to api.etherscan.io; set route.apiKey for api.etherscan.io`.
The URL is on `api.etherscan.io`, so the message gave the same host as both the place the key goes
and the reason it was not sent. The CLI documents `--backend etherscan-v2 --api-url
https://api.etherscan.io/v2/api` as the way to reach Etherscan on a chain whose row has no
Etherscan entry, and `ETHERSCAN_API_KEY` did not work with it.

## Decision

1. An `etherscan-v2` route whose `apiUrl` is on Etherscan's own API takes
   `apiKeys["etherscan-v2"]`, as a route from the routing table does. "Etherscan's own API" means
   the origin `https://api.etherscan.io`, compared after the host is lower-cased and a trailing
   dot and the default port `:443` are removed. `checkApiUrl` already removes trailing slashes on
   the path. The key still goes only to `api.etherscan.io` over `https:` on the default port, so
   R-SEC-2 holds.
2. Any other host keeps the rule of decision 0023: no key from `apiKeys`, only `route.apiKey`.
   This covers a look-alike host such as `api.etherscan.io.example.org`, another port such as
   `:8443`, and `routescan` and `blockscout-hosted` routes with `apiUrl`, even on their own host.
3. `route.apiKey` still wins over `apiKeys` on Etherscan's own API.
4. With `handlerUrl`, a route on Etherscan's own API goes to the server handler, and an Etherscan
   key in `apiKeys` or `route.apiKey` throws `invalid-input`, as
   [decision 0046](0046-handler-url-and-keyed-backend-names.md) says. This decision does not
   change that.
5. The `missing-api-key` message no longer gives the host the route is on as the reason. For an
   `etherscan-v2` route on another host it says
   `apiKeys.etherscan-v2 goes only to Etherscan's own API; set route.apiKey for this route.apiUrl`.
   For a `routescan` or `blockscout-hosted` route with `apiUrl` it says
   `a route with route.apiUrl takes no key from apiKeys.<backend>; set route.apiKey`. For
   Etherscan's own API without a key it says `set apiKeys.etherscan-v2`.

## Alternatives considered

- Keep the rule of decision 0023 and only rewrite the message. Rejected: the documented CLI
  command for a chain without an Etherscan row would still ignore `ETHERSCAN_API_KEY`, and the key
  would go to the same host either way.
- Extend the exception to `routescan` and `blockscout-hosted`. Not done: the issue reports the
  Etherscan case only. A later issue can decide them.

## Consequences

- `keyFor` and `requireKey` in `src/http/api-keys.ts` share one check, `onTableHost`.
- In the CLI, `ETHERSCAN_API_KEY` now goes with `--api-url https://api.etherscan.io/v2/api`.
