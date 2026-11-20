# unsupported-compiler

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The input comes from a compiler that this release or the route's backend does not verify.

## How to fix

Use `kind: "solc"` for Solidity compiled with solc. For ZKsync Era (324) or Sepolia (300),
pass zksolc compiler input directly with `kind: "zksolc"` on Blockscout.

Sourcify and Etherscan v2 verify Vyper input with `kind: "vyper"`, each on every chain it
serves. Name one with `route: { backend: "sourcify" }` or `route: { backend: "etherscan-v2" }`, or
let the routing table pick one. For `compiler.version`, the hint names the Vyper versions this
release accepts: 0.3.10 and later releases, not prereleases.

The build helpers still refuse zksolc and Vyper build documents; extract the input and versions
with the compiler's tooling. Use the compiler's own verification tooling for other compilers.

From the CLI: Use Solidity compiled with solc, zksolc through Blockscout on ZKsync Era (324) or
Sepolia (300), or Vyper through Sourcify or Etherscan v2. Verify other compilers with their own
tooling.

## Facts

Retryable: no.

Exit code: 2

Sent to an explorer: no.

Default hint: Use Solidity compiled with solc, zksolc through Blockscout on ZKsync Era (324) or
Sepolia (300), or Vyper through Sourcify or Etherscan v2. Verify other compilers with their own
tooling.

For end users: This contract was built with a compiler or language that cannot be verified here.
Use Solidity built with solc, zksolc on ZKsync Era or ZKsync Sepolia through Blockscout, or Vyper
through Sourcify or Etherscan v2.

For a zksolc field, the hint says instead that zksolc (EraVM) builds are not supported and that a
contract compiled with plain solc verifies with the solc build-info.

## Why

Cause: the input, or the documents passed to `buildVerifyInput`, come from a compiler that this
release or the route's backend does not verify. `details.field` names what showed it:

- `compilerType`: a Hardhat 3 build-info with a `compilerType` other than `solc`.
- `language`: a compiler input whose language is not `Solidity`, such as Vyper.
- A zksolc field: the documents come from zksolc, the compiler for ZKsync Era's EraVM, through
  foundry-zksync or hardhat-zksync. The fields are listed below.
- `compiler.kind`: a flow function such as `verify()` got input of a kind that the route's
  backend does not verify, such as `kind: "zksolc"` off ZKsync, or `kind: "vyper"` on a backend
  other than Sourcify and Etherscan v2. The flow functions are `verify()`, `dryRun()` and
  `verifyEach()`.
- `compiler.input.interfaces`: Vyper 0.3.x input with interfaces on Sourcify, which cannot verify
  it: before 0.4.0 the compiler cannot read an interface from `sources`, and Sourcify refuses a
  top-level `interfaces` field. Etherscan v2 maps such input, so the routing table picks it where
  the row lists it, and this refusal comes only when Sourcify is named. The hint says to verify on
  Etherscan v2, to inline each interface into the contract source, or to build with Vyper 0.4.0 or
  later.
- `compiler.version`: `validateInput` got a Vyper version that this release does not support: a
  release before 0.3.10, or a prerelease such as `0.4.0rc6`. It throws this before any
  `invalid-input`.

The zksolc fields:

| Field                                           | Where it comes from                               |
| ----------------------------------------------- | ------------------------------------------------- |
| `input.zksolc_version`                          | A foundry-zksync build-info                       |
| `output.zk_version`                             | A hardhat-zksync build-info                       |
| `output.metadata.zksolcVersion`                 | A contract's zksolc metadata                      |
| `metadata.zk_version`, `metadata.zksolcVersion` | A contract's zksolc metadata                      |
| `solcVersion`, `solcLongVersion`                | A version that starts with `zkVM-`                |
| `_format`                                       | A hardhat-zksync artifact, `hh-zksolc-artifact-1` |

For `compiler.kind`, the message names the kind and chain, and the backend when one was selected.
The routing table passes over such backends when another listed backend verifies the kind;
Blockscout verifies zksolc on chains 324 and 300, and Sourcify and Etherscan v2 verify Vyper on
every chain they serve.

## In code

Check the code, then read the field that named the compiler:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "unsupported-compiler")) {
    console.error(`Unsupported compiler, from ${error.details.field}.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
