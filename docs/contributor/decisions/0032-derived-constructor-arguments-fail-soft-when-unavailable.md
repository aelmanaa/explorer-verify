# 0032: Derived constructor arguments: submit without them unless the build is wrong

Status: Accepted (2026-11-04). Amends the error code list of
[decision 0009](0009-options-handle-and-errors.md).

Research: [2026-11-03: live answers for the M2 clients](../research/2026-11-03-m2-live-probes.md),
probes [A](../research/2026-11-03-m2-live-probes.md#a-etherscan-with-constructor-arguments-omitted-or-wrong)
and [D](../research/2026-11-03-m2-live-probes.md#d-similar-match-and-getcontractcreation-for-a-factory-deployment).

## Context

Issue [#64](https://github.com/aelmanaa/explorer-verify/issues/64) adds R-IN-3: when the caller
passes no `constructorArgs`, `verify()` derives them from the creation code. It needs the compiled
creation bytecode, `VerifyInput.creationBytecode`, which `buildVerifyInput` fills from build-info
output and artifacts. So derivation runs by default for any input built from build files on an
Etherscan v2, Routescan or Blockscout route.

Before derivation, those inputs were submitted without arguments, and Etherscan verified them:
in probe A, on Arbitrum Sepolia with solc 0.8.24, two directly deployed contracts got an exact
match with the arguments omitted and with wrong ones, and `getsourcecode` then held the arguments
from the chain. Blockscout also reads the arguments itself, and it reports a partial match when
the metadata hash differs. A derivation that throws whenever it cannot find the arguments would
turn working submits into errors.

On Ethereum Sepolia on 2026-11-04 (fixtures `test/fixtures/rpc/2026-11-04-*`,
`test/fixtures/etherscan/2026-11-04-getcontractcreation-*` and
`test/fixtures/constructor-args/2026-11-04-sepolia-deployments.json`):

- For a contract deployed directly, the transaction input equalled `getcontractcreation`
  `creationBytecode`, and the compiled creation bytecode (forge 1.8.1, solc 0.8.24) was its
  prefix.
- For a contract created in a factory's constructor, the transaction's `to` was `null` and its
  receipt named the factory. `getcontractcreation` returned the contract's own init code with its
  argument, after Etherscan had indexed it (it answered `No data found` for about a minute).
- For a contract created through the CREATE2 deployer
  `0x4e59b44847b379578588920cA78FbF26c0B4956C`, `to` was the deployer, and the transaction input
  was a 32-byte salt followed by the init code with its argument. `getcontractcreation` returned
  the same init code once indexed.
- One changed source comment changed the metadata hash, so the compiled bytecode no longer was a
  prefix of the creation code.

## Decision

`verify()` throws only when the creation code shows that `creationBytecode` is not the deployed
build, and only on a backend that would refuse that build anyway. In every other case it logs
why and submits without arguments, as before derivation existed.

### Where the creation code comes from

1. With `rpcUrl` and `creationTxHash`: `eth_chainId`, then the transaction.
   - A transaction to the CREATE2 deployer: the init code is the input after its 32-byte salt.
   - A transaction whose `to` is `null` or absent: the receipt's `contractAddress` must be the
     contract; then the input is the creation code.
   - Any other transaction did not create the contract directly: a factory did, or
     `creationTxHash` names another transaction.
2. Else, on an Etherscan v2 route with a key bound to it, `getcontractcreation`. A keyless request
   may reach the server handler, which does not forward the action.

### Submit without arguments

The call logs one line with a `reason` field and submits without arguments:

| `reason`                        | When                                                                                                                                                                                                               | Level  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `no-source`                     | Nothing to ask: no `rpcUrl` with `creationTxHash`, and no Etherscan key bound to the route                                                                                                                         | `info` |
| `no-creation-code`              | Every source asked gave no usable answer: a failed request, an `error` answer, nothing found, a value that is not hex, `network`, `rate-limited` or `unexpected-response` from `getcontractcreation`, or no record | `warn` |
| `factory-deployment`            | The transaction did not create the contract directly, and no explorer gave its creation code                                                                                                                       | `warn` |
| `prefix-mismatch`, `bad-length` | As below, on a backend that does not refuse another build (Blockscout)                                                                                                                                             | `warn` |

An `eth_chainId` result that is not a hex quantity counts as no usable answer.

### Throw before the submit

On a backend whose `refusesOtherBuilds` is set (the Etherscan-style clients: Etherscan v2,
Routescan and the Etherscan-compatible family), `verify()` throws `constructor-args-unavailable`
with `details.reason`:

- `prefix-mismatch`: the creation code does not start with `creationBytecode`. The input differs
  from the deployed build, and the explorer would reject it too.
- `bad-length`: what follows `creationBytecode` is not a whole number of 32-byte words.

`constructor-args-unavailable` is added to the end of `ERROR_CODES`, with exit code 2, not
retryable. Its default hint says to pass `constructorArgs` or check `creationBytecode` against the
deployed build.

### Errors that pass through

`invalid-input` naming `rpcUrl` when `eth_chainId` is a hex quantity of another chain; `timeout`
when the budget runs out; a key error from `getcontractcreation`, which the submit would get too;
and an abort.

## Alternatives considered

| Option                                                   | For                               | Against                                                                                                |
| -------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Throw on every failure, as #64 first described           | One rule; the caller always knows | Breaks submits that Etherscan verifies without arguments (probe A) whenever a source is down           |
| Throw `factory-deployment` when no explorer has a record | An early, named error             | Etherscan and Blockscout read the arguments themselves, and Etherscan indexes a child within a minute  |
| Throw `prefix-mismatch` on every backend                 | One rule                          | Blockscout reports a partial match for a build whose metadata hash differs; the error would block it   |
| Never throw: submit without arguments on any failure     | No new error path                 | On Etherscan a mismatched build fails later at the explorer, after a submit, with a less useful reason |
| Decide strictness by backend name in the flow            | No new field                      | The flow engine never branches on the backend; a `Backend` field keeps the rule with each client       |

### Size

The derivation code, `src/input/constructor-args.ts`, loads with a dynamic `import()` only when a
call derives, through the same bounded loader as the clients (decision 0031): the load ends with
`signal.reason` when the caller's signal aborts and with `timeout` when the budget runs out, and
a loaded module is kept for later calls. It gets its own `chunks` line in
`size-budget.json`, set by the rule of decision 0014: measured 1,960 bytes, ceiling 2,352, with
esbuild 0.28.2 and Node 24.21.0 zlib on 2026-11-04, on main f26cd8d plus this change. No other
ceiling changes:

| Entry                        | Set by 0031 | After  | Ceiling |
| ---------------------------- | ----------- | ------ | ------- |
| `verify`                     | 13,611      | 14,237 | 16,334  |
| `verify (one file)`          | 21,663      | 24,001 | 25,996  |
| `verify with table`          | 14,693      | 15,322 | 17,632  |
| `index`                      | 21,776      | 22,661 | 26,132  |
| chunk `etherscan`            | 3,277       | 3,513  | 3,933   |
| chunk `etherscan-compatible` | from #63    | 3,496  | 3,942   |

"Set by 0031" is each entry's `measuredBytes` in `size-budget.json`.

The `verify` entry keeps the check that decides whether to derive, the `rpcUrl` option and its
secrets. The `etherscan` chunk holds `getcontractcreation`.

## Consequences

- `Backend` has `takesConstructorArgs`, `refusesOtherBuilds` and `creationCode`, all optional.
- R-IN-3 in requirements.md states the rule. `docs/user/reference/verify.md` and the error page
  of `constructor-args-unavailable` list which failures throw and which submit without arguments.
- A caller who needs the arguments to be sent passes `constructorArgs`; they always win, and
  nothing is derived or requested.
