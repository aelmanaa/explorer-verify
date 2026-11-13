# Verify from deployed bytecode

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: tools that have a deployed contract's address but not its build files, such as a block
explorer, a wallet or a monitoring tool.

You need: Node.js 22.18 or later, or a browser; a JSON-RPC URL for the contract's chain; and the
address and chain ID. A dry run needs no API key.

solc appends a hash of the contract's metadata to the runtime bytecode. The metadata names the
compiler version, the settings and a hash for every source file. `buildVerifyInputFromBytecode`
reads that hash, finds the metadata and the sources, and returns what `buildVerifyInput` returns.

## Install

Install the core; the resolver is its `explorer-verify/resolve` entry:

```bash
npm install explorer-verify
```

## Dry run

Resolve the input from the bytecode, then dry run it:

```ts [dry-run.ts]
import { dryRun } from "explorer-verify";
import { buildVerifyInputFromBytecode } from "explorer-verify/resolve";

const target = {
  chainId: 11155111,
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
} as const;

const built = await buildVerifyInputFromBytecode(target, {
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
});
console.log(built.contractName);

const result = await dryRun({ ...target, ...built });
console.log(result.status, result.backend, result.lookup);
```

```text
contracts/Greeter.sol:Greeter
dry-run sourcify exact
```

The resolver reads the bytecode with `eth_getCode`, then looks for a verified copy on Sourcify at
the same address, on any chain. `lookup` is `exact`: Sourcify already holds this Greeter for
Sepolia, so `verify()` would submit nothing. `none` means it would submit.

## Verify

Pass the same object to [`verify()`](../reference/verify.md):

```ts [verify.ts]
import { verify } from "explorer-verify";
import { buildVerifyInputFromBytecode } from "explorer-verify/resolve";

const target = {
  chainId: 11155111,
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
} as const;

const built = await buildVerifyInputFromBytecode(target, {
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
});
const result = await verify({ ...target, ...built });
console.log(result.status);
```

```text
already-verified
```

> [!WARNING]
> A submit publishes the source on the explorer and cannot be undone.

The same input verifies the contract on another explorer. It also verifies the same bytecode at
the same address on another chain, such as a contract deployed with CREATE2.

## Where the metadata comes from

The resolver tries two sources, in this order, and uses the first metadata that matches the hash:

1. **Sourcify.** It lists the chains on which the address is verified, and fetches the metadata
   and sources of at most three: the call's chain first, then exact matches. Pass
   `allowSourcifyLookup: false` to skip it.
2. **Your IPFS gateway.** With `ipfsGateway` set, it requests `<gateway>/ipfs/<CID>` for the
   metadata, then each source by its `dweb:/ipfs/` address. There is no default gateway: pass
   one you run or pay for, such as a local node at `http://127.0.0.1:8080`.

> [!NOTE]
> The public gateways `ipfs.io` and `dweb.link` answered HTTP 429 when tested. See
> [Sources](#sources).

## How each source is checked

- The metadata's IPFS hash, computed as solc computes it, must equal the hash in the bytecode. A
  copy that differs is skipped.
- The file the hash names must be Solidity metadata. A file that is not is skipped.
- Each source file must match the keccak-256 hash in the metadata. A Sourcify source that differs
  is not used, so the gateway or your `sources` can supply it.
- A file from the gateway or from `sources` that differs fails with `source-mismatch`. With no
  source left for a file, the call fails with `incomplete-input`.

Pass `sources` for files no source holds, keyed by the path the metadata lists.

For a Swarm hash (`bzzr0` or `bzzr1`, solc before 0.6.0), the library cannot compute the hash. It
uses only an exact match on Sourcify for the same chain and address, and relies on Sourcify's
comparison.

## Options

| Option                | What it does                                                                     |
| --------------------- | -------------------------------------------------------------------------------- |
| `bytecode`            | The runtime bytecode, at most 65536 bytes. Pass it or `rpcUrl`, not both         |
| `rpcUrl`              | A JSON-RPC endpoint. The resolver checks `eth_chainId`, then calls `eth_getCode` |
| `ipfsGateway`         | An IPFS path gateway. Its query string is kept on every request                  |
| `allowSourcifyLookup` | `false` skips Sourcify, and then needs `ipfsGateway`. Defaults to `true`         |
| `sources`             | Source contents by path, for files no source holds                               |
| `fetch`               | The `fetch` every request goes through. Defaults to `globalThis.fetch`           |
| `signal`              | Cancels the call; it rejects with `signal.reason`                                |
| `timeoutMs`           | Time budget for the whole call. Defaults to 120000; at most 2147483647           |
| `logger`              | Receives log lines, with the URLs' keys removed                                  |
| `onEvent`             | Receives a `verify.retry` event before each retry of a Sourcify request          |

`allowSourcifyLookup` is not `verify()`'s `allowSourcifyFallback`. A field set to `undefined`
counts as absent. Any other key throws `invalid-input` before a request, and names the option it
may mean. [Logging and events](../reference/logging-and-events.md) describes the events.

## URLs and keys

`rpcUrl` and `ipfsGateway` take no user name, password or fragment. They must use `https`, or
`http` on a loopback host:

- `localhost`;
- `127.0.0.1`;
- `[::1]`.

Many providers put a key in the URL path or query. So every path segment and query value of eight
characters or more is removed from logs and errors. The host name is not redacted: never put a
key in it.

## Request limits

- Requests never follow a redirect.
- Answers above these sizes are refused: JSON-RPC 1 MiB, gateway 4 MiB, Sourcify 16 MiB.
  Sourcify metadata above 4 MiB is not hashed.
- The logger gets the request and retry lines of every request. A line for the RPC URL or the
  gateway carries a `label` field, `rpc` or `ipfs`, in place of a backend name.

## When it fails

Read `details.attempts` of `metadata-unavailable` to see what each source answered:

<!-- no-run: it shows how to branch on the codes; the run above covers the success path -->

```ts no-run [resolve-errors.ts]
import { ExplorerVerifyError } from "explorer-verify";
import { buildVerifyInputFromBytecode } from "explorer-verify/resolve";

try {
  await buildVerifyInputFromBytecode(
    {
      chainId: 11155111,
      address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
    },
    {
      rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
      ipfsGateway: "http://127.0.0.1:8080",
    },
  );
} catch (error) {
  if (
    error instanceof ExplorerVerifyError &&
    error.code === "metadata-unavailable"
  ) {
    for (const attempt of error.details.attempts) {
      console.log(attempt.source, attempt.outcome, attempt.status);
    }
  }
  throw error;
}
```

| Code                                                                  | Cause                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`no-metadata-hash`](../reference/errors/no-metadata-hash.md)         | No code at the address, or bytecode built without a metadata hash             |
| [`metadata-unavailable`](../reference/errors/metadata-unavailable.md) | No bytecode, no matching metadata from any source, or the time budget ran out |
| [`incomplete-input`](../reference/errors/incomplete-input.md)         | No source holds some source files; `details.candidates` lists them            |
| [`source-mismatch`](../reference/errors/source-mismatch.md)           | A file from the gateway or `sources` does not match its keccak-256 hash       |
| [`invalid-input`](../reference/errors/invalid-input.md)               | A bad option, no source allowed, or an `rpcUrl` that serves another chain     |

Bytecode built with `appendCBOR: false` or `bytecodeHash: "none"` carries no metadata hash.

## Limits

- Only Solidity compiled with solc is supported, as in `buildVerifyInput`.
- The resolver does not read bytecode from an explorer; pass `rpcUrl` or `bytecode`.
- It does not pin metadata to IPFS, and it does not fetch from Swarm.

## Sources

- IPFS gateways: on 2026-11-04, `ipfs.io` and `dweb.link` answered HTTP 429 and announced a move
  to a service-worker-only gateway.

## Next steps

- [verify()](../reference/verify.md): every option, and the dry run.
- [Verify a contract shipped in an npm package](verify-a-contract-from-an-npm-package.md): when
  you have the build files.
- [Errors](../reference/errors/index.md): each code and its fix.
