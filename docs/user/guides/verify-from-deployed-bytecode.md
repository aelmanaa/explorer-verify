# Verify from deployed bytecode

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who have a deployed contract's address but not its build files, such as a
block explorer, a wallet or a monitoring tool. `buildVerifyInputFromBytecode` and [`verify`](../reference/verify.md) exist.

solc appends a hash of the contract's metadata to the runtime bytecode. The metadata names the
compiler version, the settings and a keccak-256 hash for every source file.
`buildVerifyInputFromBytecode` reads that hash, finds the metadata and the sources it names, and
returns the `compiler` part of the verification input and the fully qualified contract name, as
`buildVerifyInput` does.

## Steps

1. Pick where the bytecode comes from: `rpcUrl`, a JSON-RPC endpoint of the contract's chain, or
   `bytecode`, the runtime bytecode you already read.
2. Call `buildVerifyInputFromBytecode` with the chain ID and the address. It looks for a verified copy
   on Sourcify at the same address, on any chain.
3. Pass the result, with the chain ID and the address, to [`verify`](../reference/verify.md).

```ts
import { verify } from "explorer-verify";
import { buildVerifyInputFromBytecode } from "explorer-verify/resolve";

const target = {
  chainId: 11155111,
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
} as const;

const built = await buildVerifyInputFromBytecode(target, {
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
});
console.log(built.contractName);

const result = await verify({ ...target, ...built });
console.log(result.status);
```

It prints:

```text
contracts/Greeter.sol:Greeter
already-verified
```

This contract is already verified on Sourcify for Sepolia, so `verify()` finds it there and
submits nothing. The same input verifies the contract on another explorer, or the same bytecode
at the same address on another chain, such as a contract deployed with CREATE2.

## Where the metadata comes from

The resolver tries two sources, in this order, and uses the first metadata that matches the hash:

1. **Sourcify.** It lists the chains on which the address is verified, and fetches the metadata
   and sources of at most three: the call's chain first, then exact matches. Pass
   `allowSourcifyLookup: false` to skip it.
2. **Your IPFS gateway.** With `ipfsGateway` set, it requests `<gateway>/ipfs/<CID>` for the
   metadata, then each source by the `dweb:/ipfs/` address the metadata lists. There is no default
   gateway: pass one you run or pay for, such as a local node at `http://127.0.0.1:8080`. On
   2026-11-04, `ipfs.io` and `dweb.link` answered HTTP 429 and announced a move to a
   service-worker-only gateway.

Each source is checked before use:

- the metadata's IPFS hash, computed as solc computes it, must equal the hash in the bytecode. A
  copy that differs is skipped;
- the file the hash names must be Solidity metadata. A file that is not is skipped;
- each source file must match the keccak-256 hash the metadata records. A Sourcify source that
  differs is not used, so the gateway or your `sources` can supply it; with neither, the call
  fails with `incomplete-input`. A file from the gateway or from `sources` that differs fails with
  `source-mismatch`, as in `buildVerifyInput`.

For a Swarm hash (`bzzr0` or `bzzr1`, solc before 0.6.0), the library cannot compute the hash. It
uses only an exact match on Sourcify for the same chain and address, and relies on Sourcify having
compared the hash; it does not compare it itself.

Pass `sources` for files no source holds, keyed by the path the metadata lists. Each must match its
keccak-256 hash.

## Options

| Option                | What it does                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bytecode`            | The runtime bytecode, `0x` and hex digits, at most 65536 bytes. Pass it or `rpcUrl`, not both                                         |
| `rpcUrl`              | A JSON-RPC endpoint. The resolver checks `eth_chainId`, then calls `eth_getCode` at `latest`                                          |
| `ipfsGateway`         | An IPFS path gateway. Its query string is kept on every request                                                                       |
| `allowSourcifyLookup` | `false` skips Sourcify; it then needs `ipfsGateway`. Defaults to `true`. Not the same as `verify()`'s `allowSourcifyFallback`         |
| `sources`             | Source contents by path, for files no source holds                                                                                    |
| `fetch`               | The `fetch` every request goes through. Defaults to `globalThis.fetch`                                                                |
| `signal`              | Cancels the call; it rejects with `signal.reason`                                                                                     |
| `timeoutMs`           | Time budget for the whole call, in milliseconds. Defaults to 120000                                                                   |
| `logger`              | Receives log lines, with the URLs' keys removed                                                                                       |
| `onEvent`             | Receives a `verify.retry` event before each retry of a Sourcify request; see [Logging and events](../reference/logging-and-events.md) |

A field set to `undefined` counts as absent. Any other key throws `invalid-input` before any request,
naming the key and, when one is close, the option it may mean.

`rpcUrl` and `ipfsGateway` must use `https`, or `http` on `localhost`, `127.0.0.1` or `[::1]`, with
no user name, password or fragment. Many providers put a key in the URL path or query, so every
path segment and query value of eight characters or more is removed from logs and errors. The host
name is not redacted, so never put a key in it.

Requests never follow a redirect. A JSON-RPC answer above 1 MiB, a gateway answer above 4 MiB and
a Sourcify answer above 16 MiB are refused, and Sourcify metadata above 4 MiB is not hashed. The
logger gets the request and retry lines of every request. Lines for `rpcUrl` and `ipfsGateway`
carry a `label` field, `rpc` or `ipfs`, in place of a backend name.

## When it fails

<!-- no-run: it shows how to branch on the codes; the run above covers the success path -->

```ts no-run
import { ExplorerVerifyError } from "explorer-verify";
import { buildVerifyInputFromBytecode } from "explorer-verify/resolve";

try {
  await buildVerifyInputFromBytecode(
    { chainId: 11155111, address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc" },
    { rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", ipfsGateway: "http://127.0.0.1:8080" },
  );
} catch (error) {
  if (error instanceof ExplorerVerifyError && error.code === "metadata-unavailable") {
    for (const attempt of error.details.attempts) {
      console.log(attempt.source, attempt.outcome, attempt.status);
    }
  }
  throw error;
}
```

| Code                                                                  | Cause                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`no-metadata-hash`](../reference/errors/no-metadata-hash.md)         | No code at the address, or bytecode built with `appendCBOR: false` or `bytecodeHash: "none"`               |
| [`metadata-unavailable`](../reference/errors/metadata-unavailable.md) | The endpoint gave no bytecode, no source returned matching metadata, or the time budget ran out            |
| [`incomplete-input`](../reference/errors/incomplete-input.md)         | No source holds some source files; `details.candidates` lists them                                         |
| [`source-mismatch`](../reference/errors/source-mismatch.md)           | A file from the gateway or `sources` does not match its keccak-256 hash                                    |
| [`invalid-input`](../reference/errors/invalid-input.md)               | A bad option, `allowSourcifyLookup: false` without `ipfsGateway`, or an `rpcUrl` that serves another chain |

## Limits

- Only Solidity compiled with solc is supported, as in `buildVerifyInput`.
- The resolver does not read bytecode from an explorer; pass `rpcUrl` or `bytecode`.
- It does not pin metadata to IPFS, and it does not fetch from Swarm.
