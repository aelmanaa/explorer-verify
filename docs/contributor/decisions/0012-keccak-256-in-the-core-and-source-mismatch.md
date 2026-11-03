# 0012: Keccak-256 written in the core; a changed source is source-mismatch

Status: Accepted (2026-11-03). Amends the error code list of
[decision 0009](0009-options-handle-and-errors.md).

Research: none (maintainer choice).

## Context

`buildVerifyInput` rebuilds the Standard JSON input from Solidity metadata and source files (R-IN-7,
[#21](https://github.com/aelmanaa/explorer-verify/issues/21)). The metadata records the keccak-256
hash of each source. A source that differs by one byte compiles to other bytecode, and the explorer
then reports a failed verification with no hint that a file was wrong. The builder hashes each
source before it returns, so it needs keccak-256.

The core has no runtime dependencies, and third-party code must be vendored under
`src/internal/vendor/` with its licence notice (decision 0008, R-RUN-4). The web platform offers
SHA-256 in `crypto.subtle`, but not keccak-256. Keccak-256, as Ethereum and solc use it, is the
Keccak sponge with a 1088-bit rate and the original padding byte `0x01`. SHA3-256 in FIPS 202 is the
same sponge with the padding byte `0x06`
([Keccak team summary](https://keccak.team/keccak_specs_summary.html) and
[FIPS 202](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.202.pdf), section 3.2 and appendix B.2,
read 2026-11-03).

The builder also needs an error for a source whose hash differs. The existing codes do not fit:
`invalid-input` names a field of the caller's input, and `incomplete-input` names something absent.

## Decision

- Keccak-256 is written in the core, in `src/internal/keccak.ts`, from the specification: about
  170 lines, 852 bytes after minification and gzip (esbuild 0.25.0, 2026-11-03). It is not
  exported from the package entry point. The state is a `Uint32Array` of 50 words and input is
  read through a `DataView`, little-endian. It hashes 1 MB in about 135 ms and 10 MB in about
  1.5 s on Node 24 (2026-11-03); a first version that kept the state in a `DataView` took about
  4 s for 1 MB.
- It is checked four ways in the unit tests: the published digests of the empty input and `"abc"`
  and the digest of a 200-byte input; the hashes solc recorded for the fixture sources; with the
  SHA-3 padding byte, the result of `node:crypto` `sha3-256` for every length from 0 to 600 bytes
  and for 200 pseudo-random lengths up to 5,000 bytes; and a time budget for 1 MB of two seconds,
  best of three runs.
  The vectors live in `test/fixtures/keccak256-vectors.json` for the browser smoke test (#19).
- Add the error code `source-mismatch`: a source passed to `buildVerifyInput` does not match the
  keccak-256 hash the metadata records. `details` holds `path`, `expected` and `actual`. Exit code
  2, not retryable.
- A source the metadata lists with no content anywhere is `incomplete-input` with `field`
  `sources`. `details.candidates` lists the missing paths, sorted, at most 1,000; the message
  gives the full count.
- The rebuild copies every metadata setting except `compilationTarget`, with these exceptions,
  each checked by compiling the rebuilt input again with the solc version that wrote the metadata:
  `libraries` is regrouped by path, and a bare name (solc 0.7.4 and earlier) goes under the empty
  path; with `metadata.appendCBOR: false`, `metadata.bytecodeHash` is dropped, because solc
  records it and then rejects it in an input; for solc 0.8.2 to 0.8.4, `optimizer.details.inliner`
  becomes `optimizer.enabled`, because those versions record the key and then reject it; and when
  a source embeds its content without `metadata.useLiteralContent` (solc 0.5.0 and earlier), the
  flag is set to `true`.

## Alternatives considered

| Option                                        | For                                                                  | Against                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor the SHA-3 module of an audited library | Code with an audit and wide use                                      | Brings its shared helpers and the other SHA-3 and SHAKE variants, or a hand-cut copy that is no longer the audited code; a licence file |
| Write keccak-256 in the core (chosen)         | One function, no licence notice, small, tested against `node:crypto` | The repository maintains it; a bug would be ours                                                                                        |
| Skip the hash check                           | No code                                                              | A changed source surfaces only as a failed verification on the explorer, with no file named                                             |
| Report a mismatch as `invalid-input`          | No new code                                                          | The caller cannot read the path and both hashes from typed `details`                                                                    |

## Consequences

- `ERROR_CODES`, `ERROR_EXIT_CODES`, the error reference, the JSON reference and the envelope
  schema's code list gain `source-mismatch`.
- R-IN-6 no longer says the core lacks keccak-256. Address checksums stay unchecked: explorers
  accept any case.
- The bytecode-metadata resolver (R-IN-5) reuses the rebuild and the hash check.
- The keccak-256 code counts toward the bundle budget when the builder is imported. The `verify`
  entry does not import the builder.
