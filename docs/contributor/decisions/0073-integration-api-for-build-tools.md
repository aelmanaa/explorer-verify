# 0073: Integration fields for build tools: the page base, the failure cause, the stored contract event and explorer labels

Status: Accepted (2026-11-12). Extends R-FLOW-3, R-FLOW-4, R-DX-3 and R-DX-6; amends the label
point of [decision 0061](0061-hint-wording-and-end-user-hints.md) (alternatives table) and adds an
event type to the set of [decision 0058](0058-settle-event-and-envelope-fields.md).

Research: [Etherscan client](../research/2026-11-04-etherscan-client.md),
[live matrix](../research/2026-11-04-live-matrix.md) (the recorded Etherscan and Routescan bytecode
mismatches), [Blockscout client](../research/2026-11-04-blockscout-client.md) (its bare
`Fail - Unable to verify`), [matches from another contract's source](../research/2026-11-10-foreign-matches.md),
and Etherscan's documented verification errors
([Common Verification Errors](https://docs.etherscan.io/contract-verification/common-verification-errors),
read 2026-11-12). Evidence: issues
[#389](https://github.com/aelmanaa/explorer-verify/issues/389),
[#390](https://github.com/aelmanaa/explorer-verify/issues/390),
[#391](https://github.com/aelmanaa/explorer-verify/issues/391) and
[#392](https://github.com/aelmanaa/explorer-verify/issues/392).

## Context

A build tool's verify plugin was rebuilt on explorer-verify 0.2.1 as a proof of concept, keeping
its commands, configuration and console output. Four workarounds remained in the adapter:

1. A route given by `route.apiUrl` has no explorer page, so the adapter built the contract link
   itself from its own chain descriptors.
2. The plugin retries with its full compiler input when the minimal input fails, unless the
   failure is about constructor arguments, which a retry cannot fix. A `failed` result carried
   only the explorer's text, so the adapter matched `correct constructor argument` in `reason`, as
   the plugin's own Etherscan client did (`@nomicfoundation/hardhat-verify` 3.1.5,
   `NON_RETRYABLE_FAILURE_PATTERNS`).
3. The plugin tells the user which contract the explorer holds before the submit. The library
   said so only in a log line, so the adapter picked log lines by substring.
4. Messages and hints named the backend id, such as `etherscan-v2`, where users expect the
   explorer's name. The adapter replaced the id in the `not-confirmed` message.

## Decision

1. **`route.explorerUrl`.** `RouteOverride` gains `explorerUrl`, the explorer's page base. It is
   checked as `route.apiUrl` is (a string of at most 8192 characters; `https:`, or `http:` on
   `localhost`, `127.0.0.1` or `[::1]`; no user name, password or fragment), and must not hold a
   query string, since the client appends the contract's path. Trailing slashes are removed. Any
   other value throws `invalid-input` naming `route.explorerUrl`, without the value. It applies to
   any route, with or without `apiUrl`, and replaces the row's page. The page is built as the
   table builds its own: `<base>/<chainId>/<address>` for Sourcify, `<base>/address/<address>?tab=contract`
   for both Blockscout backends, and `<base>/address/<address>#code` for the Etherscan-style ones.
   No request goes to it. `verify()`, `dryRun()`, `checkStatus()`, `verifyEach()` entries and
   `linkProxy()` read it through the route.
2. **`reasonCode` on `failed`.** A `failed` `VerifyResult` gains `reasonCode`, typed
   `FailureReasonCode`; `reason` stays the explorer's text. The values are what the clients can
   tell apart in the answers they parse:

   | Value               | Sourcify job error codes                                                                                                                            | Etherscan-style text (Etherscan, Routescan, standalone)     |
   | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
   | `missing-source`    | `missing_source`, `missing_or_invalid_source`, `extra_file_input_bug`; `compiler_error` with `Source "…" not found`                                 | `Source "<path>" not found`                                 |
   | `constructor-args`  | none: Sourcify reads the arguments from the creation code                                                                                           | `constructor argument`                                      |
   | `libraries`         | none                                                                                                                                                | `Library was required`                                      |
   | `contract-name`     | `invalid_compilation_target`, `contract_not_found_in_compiler_output`, `runtime_bytecode_not_found_in_compiler_output`, `compiled_bytecode_is_zero` | `Unable to locate ContractName`                             |
   | `bytecode-mismatch` | `no_match`, `bytecode_length_mismatch`                                                                                                              | `bytecode does not match`, `bytecodehash` (any letter case) |
   | `compiler`          | `compiler_error`, `invalid_compiler_version`, `unsupported_compiler_version`, `invalid_language`, `unsupported_language`                            | `Compilation Error`, `solc version`                         |
   | `unknown`           | `onchain_bytecode_is_zero`                                                                                                                          | any other text, such as a bare `Fail - Unable to verify`    |

   The Etherscan-style rows are checked in this order, on the whole text in lower case, before the
   reason is cut to 300 characters. A missing source comes first because solc reports it inside a
   compilation error. Blockscout's status answer is the bare `Fail - Unable to verify` in every
   recorded failure, so its `failed` result is always `unknown`. The Sourcify mapping reads the job
   error code; `extra_file_input_bug` says the deployed build compiled more files than the input
   holds, the case a tool's minimal input meets, so it is `missing-source`. Only the bytecode
   mismatches of Etherscan and Routescan, and Sourcify's `no_match` and
   `contract_not_found_in_compiler_output`, are recorded answers; the other Etherscan phrases come
   from its documentation and are tested with those texts.

   The field is required in the type. The envelope reader takes a result without it, from an older
   copy, or with a value it does not know, from a newer copy, as `unknown`. The envelope schema
   lists it as an optional enum, so schema version 1 still accepts older envelopes.

3. **`verify.stored`.** A new event, emitted by `verify()` (and each `verifyEach()` entry) right
   after `verify.lookup` and before the submit, when the lookup found another contract's source.
   Its fields are `backend`, and `name` and `compilerVersion` when the explorer gives them, the
   same text `storedContract` carries: cut to 300 characters by the client, with the call's keys
   redacted, and redacted again by the observer. A match of this source or an answer that names no
   contract emits none, and neither do `dryRun()` and `checkStatus()`. The name follows the other
   event names: a lowercase `verify.` prefix and one word, as OpenTelemetry's event naming asks.
   The issue's `verify.storedContract` has an upper-case letter.
4. **Labels.** `BACKEND_LABELS`, exported from `explorer-verify/backends` and `explorer-verify`,
   maps each backend to the name people know: `Etherscan`, `Blockscout` for both Blockscout
   backends, `Sourcify`, `Routescan`, and `Etherscan-compatible explorer`. The routing table gives a
   standalone explorer no name, so its label is generic. The flow's messages, log lines and hints
   name the explorer by its label: the `not-confirmed`, `job-not-found`, `unknown-state` and
   `missing-api-key` messages, the key-answer messages, the dry run's messages, the
   stored-contract lines, the proxy-link lines, and the routing table's `unsupported-chain`
   message. Blockscout's hosted API key errors say `Blockscout's hosted API`, as its other message
   does. `details.backend` and the `backend` log field keep the id. The id stays in text only where
   it is a value to set, such as `apiKeys.etherscan-v2` or `route.backend`, or names a module, such
   as `the sourcify client`. The label is a plain object literal, so a bundle that does not read it
   drops it.

The decision 0061 rule that hints name values in words is unchanged. Its alternatives table
rejected labels in end-user hints for their bytes and upkeep; messages now carry the label, and
`hintFor` still does not.

## Alternatives considered

| Option                                                          | For                                   | Against                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `route.explorerUrl` as a template with `{address}`              | Any page layout                       | One more format to check and document; the three table layouts cover the explorers the table lists            |
| `reasonCode` on the `already-verified` result after a rejection | Says why a submit over a match failed | That result is not a failure; the `warn` line already gives the reason                                        |
| `cause` as the field name (the proof of concept's G6)           | Short                                 | `Error.cause` means a thrown value; a result field of that name invites `result.cause instanceof Error`       |
| A `retryable` boolean instead of a code                         | One check for the build tool          | Which causes a retry fixes depends on the tool's two inputs; the code lets each tool decide                   |
| Classify Blockscout's text as `bytecode-mismatch`               | Most failures are mismatches          | The recorded case was wrong optimizer runs; the answer names no cause, so `unknown` is the honest value       |
| `storedContract` on `verify.lookup` instead of a new event      | No new type                           | `verify.lookup` reports the grade and compares no names (decision 0063); mixing the two changes what it means |
| The row's explorer host as a standalone explorer's label        | Names the explorer                    | Needs the route at every message; the host is in `route` and `verify.routed` already                          |

## Consequences

- A tool links the contract page for its own routes, retries on `reasonCode === "missing-source"`
  or on any code but `constructor-args`, shows the stored contract from `verify.stored`, and shows
  library messages as they are.
- `VerifyResult` code that builds a `failed` result, such as a test double, adds `reasonCode`.
  An exhaustive `switch` on `VerifyEvent["type"]` adds `verify.stored`; the CLI prints it at
  `debug`, as its `info` log line already says the same.
- Messages are diagnostics (R-DX-5, decision 0061): a caller that matched `etherscan-v2` in a
  message reads `details.backend` instead.
- Bundle size, measured with `pnpm run size` on 2026-11-12 against `main` at `26e1458` (esbuild
  0.28.2, Rollup 4.67.4, Node.js 24.21.0 zlib), in bytes gzipped:

  | Entry or chunk                 | Main 26e1458 | This change | Ceiling | New ceiling |
  | ------------------------------ | ------------ | ----------- | ------- | ----------- |
  | `backends` (`export *`)        | 168          | 229         | 202     | 275         |
  | `verify`                       | 18,745       | 19,023      | 19,738  | 19,738      |
  | `checkStatus`                  | 15,536       | 15,818      | 17,006  | 17,006      |
  | `index` (`export *`)           | 32,131       | 32,446      | 37,820  | 37,820      |
  | `envelope`                     | 9,553        | 9,626       | 10,365  | 10,365      |
  | chunk `sourcify`               | 3,124        | 3,270       | 3,462   | 3,462       |
  | chunk `etherscan`              | 3,894        | 4,062       | 4,738   | 4,738       |
  | chunk `routescan`              | 4,010        | 4,164       | 4,851   | 4,851       |
  | `checkStatus` per name, Rollup | 19,011       | 19,283      | 19,041  | 23,140      |
  | `linkProxy` per name, one file | 30,642       | 31,116      | 31,083  | 37,340      |

  The Sourcify and Etherscan-style chunks carry the reason code tables. The flow's messages read
  `BACKEND_LABELS`. The three ceilings that the change passes rise by the
  [decision 0014](0014-measured-bundle-ceilings.md) rule, the measured size plus 20% rounded up.
  `name-budget.json` gains a `BACKEND_LABELS` row for `explorer-verify` and for
  `explorer-verify/backends`.
