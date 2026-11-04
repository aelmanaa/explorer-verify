# metadata-unavailable

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: `resolveInputFromBytecode` could not get what it needs. The JSON-RPC endpoint gave no
bytecode, no source returned usable metadata for the hash in the bytecode, the IPFS gateway failed
on a source file the metadata lists, or the time budget ran out. `details.hash` holds the hash from
the bytecode, as `ipfs:` and the CID or `bzzr0:` or `bzzr1:` and 64 hex digits. It is empty when
the bytecode was not read. `details.attempts` lists each source tried, in order:

- `source`: `rpc`, `ipfs` or `sourcify`;
- `outcome`: `not-found` (the source does not hold it), `hash-mismatch` (metadata of another
  build), `not-metadata` (the file has the right hash but is not Solidity metadata), `unavailable`
  (no usable answer after retries, an answer too large, or bytecode above 65536 bytes) or
  `timeout` (the time budget ran out; the resolver stops there);
- `status`: the HTTP status of the last answer, when there was one.

Fix: read `details.attempts`. For `rpc`, check the endpoint and its key. For `not-found` on
Sourcify, pass `ipfsGateway` with a gateway that holds the metadata. For `not-found` on the
gateway, the metadata is not pinned where the gateway can find it. For `hash-mismatch` or
`not-metadata`, the copy belongs to another build. For `unavailable`, call again later. For
`timeout`, raise `timeoutMs`.

Default hint: Read details.attempts. Call again later, or pass an ipfsGateway that holds the
metadata.

Retryable: yes. A gateway or endpoint that failed may answer later. Nothing was sent to an
explorer.

Exit code: 5

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
