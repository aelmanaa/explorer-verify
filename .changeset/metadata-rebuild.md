---
"explorer-verify": patch
---

`buildVerifyInput` now rebuilds the Standard JSON input from Solidity metadata and the source files, so a package that ships a Foundry artifact or a metadata string without build-info can be verified. It accepts metadata as an object, as a JSON string, or in an artifact's `rawMetadata` or `metadata`. Pass the sources the metadata does not embed in the new `sources` option, keyed by path. The version comes from `compiler.version` and the contract from `settings.compilationTarget`. The settings are copied from the metadata, with `libraries` converted to the Standard JSON form.

Before it returns, the builder hashes each source with keccak-256 and compares the hash with the metadata. A missing source fails with `incomplete-input` on `sources`, listing the missing paths (at most 1,000; the message gives the count). A source that differs fails with the new error code `source-mismatch`, which names the file and both hashes and exits with code 2.

Metadata from solc 0.5.0 to 0.8.24 is tested. The builder adjusts three settings that solc records but rejects in an input: it drops `bytecodeHash` when `appendCBOR` is `false`, moves `optimizer.details.inliner` to `optimizer.enabled` for solc 0.8.2 to 0.8.4, and sets `useLiteralContent` when the metadata embeds the sources without it. A library keyed by bare name, as solc 0.7.4 and earlier write it, goes under the empty path. In a rebuild, `options.contract` must name the metadata's own contract.

`validateInput` now also rejects a source path with a Unicode format character, such as a bidirectional override.

[#21](https://github.com/aelmanaa/explorer-verify/issues/21)
