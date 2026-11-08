# Recover incomplete deployment information

A verification assistant can collect and validate inputs in stages. It must keep known facts,
recovered facts and unresolved fields separate. The SDK accepts compiler input; it never compiles
contracts itself (R-IN-2).

## Start with the deployment

Obtain the chain ID, deployed contract address and, when available, creation transaction hash.
Check the RPC endpoint's chain. Establish whether the address is the implementation, a proxy or a
factory-created contract. Verification and linking a proxy are separate SDK operations.

Ask for the project's build outputs, release artifacts, compiler input or Solidity metadata.
Search only the project folders the user supplied. CI artifacts and a deployment's source revision
can preserve details the developer no longer remembers. Do not search the machine for API keys.

## Try published metadata

The public `buildVerifyInputFromBytecode` export in `explorer-verify/resolve` accepts a chain and
address with an RPC endpoint, or runtime bytecode already obtained by the caller. It reads the
metadata hash and can obtain matching metadata and sources from Sourcify or a caller-configured
IPFS gateway. It checks metadata and source hashes before rebuilding the input.

See the existing [deployed-bytecode guide](../docs/user/guides/verify-from-deployed-bytecode.md).
This operation is available in the SDK. The current CLI does not expose an address-only recovery
command. A deployment tool can call the resolver and save the completed request for the CLI.

Recovery needs retrievable metadata and sources. An address whose source was never published,
whose metadata hash was omitted, or whose files disappeared may remain unverifiable until the
user supplies the missing material. Runtime bytecode alone does not provide the original Solidity
source and complete compiler configuration.

## Assemble a candidate request

`buildVerifyInput` accepts compiler Standard JSON, compatible build-info, or Solidity metadata with
its required source contents. Its structured errors name missing fields and candidate contracts.
A bare Standard JSON input also needs the full compiler version and a fully qualified contract
name such as `contracts/Token.sol:Token`.

Preserve the original source paths, source contents and compiler settings. They affect the result.
Collect library addresses and ABI-encoded constructor arguments. Where the compiled creation
bytecode and creation transaction are available, the SDK can derive missing constructor arguments;
that is not a universal recovery method for factory deployments.

An LLM should ask for unresolved information or explain the next recovery step. It must not fill
unknown optimizer settings, compiler versions, source code or constructor values with guesses and
present the result as the original deployment input.

## Validate before submitting

The CLI accepts a complete request with:

```sh
explorer-verify verify --input-json request.json --dry-run --json
```

Put the selected backend in the request's `route.backend`. A dry run validates the request and
checks routing and the explorer lookup. It does not compile the sources or establish that the
resulting bytecode matches the deployment. When candidate build details are uncertain, recompile
locally and compare the relevant code, accounting for constructor arguments, linked libraries,
immutables and metadata. Keep unresolved differences visible.

Before a real verification request, obtain the user's authorization to publish the source. Supply
explorer keys through the supported environment, file or stdin mechanisms, never a literal key
flag. The caller's key must not appear in an LLM prompt or a command log.

## Return useful outcomes to an LLM

Parse the CLI envelope and exit code, rather than treating every nonzero exit as a process crash.
The error fields include `code`, `hint`, `details` and `retryable`. Follow the hint and preserve the
error code when asking the user for missing input. An explorer rejection is a failed result,
which needs the reason and a concrete next step such as checking the build settings or address.

When verification is pending, preserve the handle and call `status` to continue. Repeating
`verify` can create another submission. An unknown state needs review. Source recovery, input
validation, a submitted job and a verified contract are different states in the assistant's answer.

See the [JSON and exit-code contract](../docs/user/reference/json-output.md) and
[agent guide](../docs/user/guides/using-from-an-agent.md).
