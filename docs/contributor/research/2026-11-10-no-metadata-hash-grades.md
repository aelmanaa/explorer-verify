# Match grades for builds without a metadata hash

Date: 2026-11-10. Scope: issue #287. What grade does each explorer give a contract compiled with
`bytecodeHash: "none"`, and which `match` does explorer-verify 0.1.0 report for it?

## Sources

- Issue #287: https://github.com/aelmanaa/explorer-verify/issues/287
- Etherscan, [Types of contract verification](https://info.etherscan.com/types-of-contract-verification/),
  read 2026-11-04 (cited in [match types](../../user/explanation/match-types.md)).
- Sourcify, [exact match and match](https://docs.sourcify.dev/docs/exact-match-vs-match/), read
  2026-11-04.
- Solidity, [compiler input](https://docs.soliditylang.org/en/v0.8.24/using-the-compiler.html),
  read 2026-11-04.
- The earlier Blockscout run on Base Sepolia:
  [Blockscout client research](2026-11-04-blockscout-client.md).
- The live probe below: forge 1.8.1, solc 0.8.24, viem 2.57.14 for the deploys, explorer-verify
  0.1.0 built from `main` at `9d55a2a`, Node.js 24.21.0, on 2026-11-10 between 14:02 and 14:16 UTC.

## The probe

One contract, `MatchGrade287`, with a `uint256 public constant TAG` set to a random number for
each deployment, so no explorer held a match for any of them before. Two builds, each with
solc 0.8.24, optimizer on with 200 runs and `evmVersion` `cancun`:

- `nohash`: `bytecode_hash = "none"` in `foundry.toml`, so `settings.metadata.bytecodeHash` is
  `"none"`. The runtime code ends in `a164736f6c6343000818000a`: CBOR with the compiler version
  only.
- `ipfs`: the default. The runtime code ends in `a2646970667358221220…64736f6c63430008180033`.

Each build was deployed five times on Ethereum Sepolia (11155111), once per backend, so each
verification below was the first submit for its address. Every `verify()` call first looked the
contract up and found no match. The input came from `@explorer-verify/foundry` 0.1.0 over the
`forge build --build-info` output, and each call pinned `route.backend`.

| Build  | Backend             | Address                                      | Deploy transaction                                                                                                       | Block    |
| ------ | ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| nohash | `etherscan-v2`      | `0x4516568fe694b225ddb62ea1f0b0a956e4149032` | [`0x13a73b…bd48`](https://sepolia.etherscan.io/tx/0x13a73baab35e8add6f076d3de72f8766edeb33c63e986e7ffa2150c8babebd48)    | 12105097 |
| nohash | `blockscout`        | `0xea02aff76e67b89aea47c4fa0e6639e4eece1d32` | [`0xedbb49…5117`](https://sepolia.etherscan.io/tx/0xedbb49aa77eb5a10a7cd0c9335ae281deb286d420a4a7f1d1e770b4955ae5117)    | 12105098 |
| nohash | `blockscout-hosted` | `0x21daa94317e22dc667f5b3088fc7905187ac6813` | [`0x44e1bc…106247e`](https://sepolia.etherscan.io/tx/0x44e1bc3425e0d4f5b0e83329a46732234b1efb47b614a5d7ee43216c2106247e) | 12105099 |
| nohash | `routescan`         | `0x83f6c8a7ae518eb4a0a460d6119184f3639f568b` | [`0x9eb226…8cd3`](https://sepolia.etherscan.io/tx/0x9eb226029c0b29abce08f225ecaf8f9bfcb36fd9ef7b8263039554a4ac1d8cd3)    | 12105101 |
| nohash | `sourcify`          | `0xd6f4ed540d68798effeb7937f3894f8e51dc0444` | [`0xd418b9…48c2`](https://sepolia.etherscan.io/tx/0xd418b9c533bb344746219722ed943eba1c94901dc46fdbb271edb9f19cd848c2)    | 12105102 |
| ipfs   | `etherscan-v2`      | `0xfd54262c03da0595915f7ca5ddaf0d23199b9e2e` | [`0x8e7a08…9f9c`](https://sepolia.etherscan.io/tx/0x8e7a08215ea6e3a2804e969c616e6c615f17f06b3551f635a19f0f50639d9f9c)    | 12105104 |
| ipfs   | `blockscout`        | `0x86e702dd61c47c2934a1caf6faf51588c412d913` | [`0x90bd81…aa77`](https://sepolia.etherscan.io/tx/0x90bd81ca8830a161370092dc3f63808d645d8ec9ca69eff1170ec29f89d1aa77)    | 12105105 |
| ipfs   | `blockscout-hosted` | `0x47dcf6c8ab017844bf3e469a60b1a879ebca22f7` | [`0x8934eb…011b`](https://sepolia.etherscan.io/tx/0x8934ebba46796ec3bc3dbafd93a30d13026fc03f3cf1e5a0ae3534031a0a011b)    | 12105106 |
| ipfs   | `routescan`         | `0x5298b8390885d5baa0af01d28573933b13aa3dda` | [`0x663197…68dc`](https://sepolia.etherscan.io/tx/0x66319777353dd96ab1f3c40f24c079cec620e10bf4868e7af1f1649c194a68dc)    | 12105107 |
| ipfs   | `sourcify`          | `0xec5ffe60b175ca533cc3b0aa6c54f9bf5f37026b` | [`0x66a710…e3e4`](https://sepolia.etherscan.io/tx/0x66a710e8d40277271313c75181e552259f0ca4e374fe415fd2333a7a2715e3e4)    | 12105109 |

The ten deploys cost 373,725,057 wei in total, at 67 to 70 wei of gas price.

## Results

What `verify()` returned, and what the explorer's own answer said. All times are UTC on
2026-11-10.

| Backend             | Build  | Explorer's answer                                                                                                                                | `verify()` result     |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `etherscan-v2`      | nohash | `checkverifystatus` `Pass - Verified` (14:05:24); `getsourcecode` then gave `SourceCode` and `SimilarMatch` `""`                                 | `verified`, `exact`   |
| `etherscan-v2`      | ipfs   | `Pass - Verified` after eight `Pending in queue`; `SimilarMatch` `""`                                                                            | `verified`, `exact`   |
| `sourcify`          | nohash | Job completed at 14:09:48 with `match`, `creationMatch` and `runtimeMatch` all `match`                                                           | `verified`, `partial` |
| `sourcify`          | ipfs   | Job completed at 14:09:53 with all three `exact_match`                                                                                           | `verified`, `exact`   |
| `blockscout`        | nohash | `Pass - Verified`; the REST lookup then gave `is_fully_verified` `false`, `is_partially_verified` `true`, `is_verified_via_sourcify` `false`     | `verified`, `partial` |
| `blockscout`        | ipfs   | `Pass - Verified`; `is_fully_verified` `true`, `is_partially_verified` `false`                                                                   | `verified`, `exact`   |
| `blockscout-hosted` | nohash | `Pass - Verified` after ten `Pending in queue`; the hosted lookup gave `is_fully_verified` `false`, `is_partially_verified` `true`               | `verified`, `partial` |
| `blockscout-hosted` | ipfs   | `Pass - Verified`; `is_fully_verified` `true`                                                                                                    | `verified`, `exact`   |
| `routescan`         | nohash | `Pass - Verified` at the first poll; `getsourcecode` has no grade field: no `SimilarMatch`, nothing that tells an exact match from a partial one | `verified`, `exact`   |
| `routescan`         | ipfs   | The same                                                                                                                                         | `verified`, `exact`   |

So for a build without a metadata hash, on 2026-11-10:

- Etherscan v2 graded it as it grades a build with a hash. `getsourcecode` had an empty
  `SimilarMatch`, which is how its API marks a match that was not copied from another contract.
  This fits Etherscan's definition of an Exact Match, "the exact contract code that was deployed",
  which names no metadata hash. The issue's guess holds: a fresh submit gives `exact`.
- Sourcify gave `match`, not `exact_match`, on both the creation and the runtime code. This
  confirms the 2026-09-10 run the issue cites.
- Blockscout, on the instance and through the hosted API, gave a partial verification. This
  confirms the 2026-11-04 run on Base Sepolia.
- Routescan's API has no grade, so explorer-verify reports `exact` for any Routescan match. It
  did so here too, for a build that Sourcify and Blockscout grade partial.

The Etherscan explorer page, `https://sepolia.etherscan.io/address/0x4516568fe694b225ddb62ea1f0b0a956e4149032#code`,
answered a Cloudflare challenge to curl and to a headless Chromium (Playwright) on 2026-11-10, so
its badge was not read. The API's empty `SimilarMatch` is the only Etherscan answer recorded.

## Forwarding between explorers

Lookups of all ten contracts on all five backends ran twice, at 14:10:57 and 14:15:32, with
`dryRun()`. They show that a submit to one explorer reached others:

- A Sourcify submit forwarded to Blockscout and Routescan. Its job answer listed
  `externalVerifications` for `blockscout` and `routescan` with job ids, and for `etherscan` the
  error `Daily limit of 500 source code submissions reached`. Etherscan stayed unverified for both
  Sourcify contracts.
- Both Blockscout submits, instance and hosted, were on Sourcify and Routescan at the first
  lookup pass. Sourcify's `verifiedAt` was within two seconds of Blockscout's `verified_at` for
  each of the four contracts (for example 14:06:43 on both for the nohash instance contract).
  Sourcify graded the nohash copies `match` and the ipfs copies `exact_match`.
- The nohash Etherscan contract was on Sourcify as `match` with `verifiedAt` 14:10:24, and on
  Blockscout from 14:10:26 with `is_verified_via_sourcify` `true`, partial. The ipfs Etherscan
  contract was on neither. What submitted the first one to Sourcify is not known.
- The Routescan submits reached no other explorer.

Every forwarded copy had the grade the receiving explorer gives that build: Sourcify and
Blockscout graded the nohash copies partial, and Routescan reported every copy as verified with no
grade.

## Rate limits seen

While polling the nohash job, `eth-sepolia.blockscout.com/api` answered HTTP 429 `Too many
requests` 15 times; explorer-verify retried and finished. Etherscan answered `Max calls per sec
rate limit reached (3/sec)` once, before the ipfs submit; the submit was retried and accepted.

## Fixtures

The recorded answers of the nohash runs are in `packages/explorer-verify/test/fixtures/`, with
`2026-11-10-` names that contain `no-metadata-hash`: four under `etherscan/`, four under
`sourcify/`, nine under `blockscout/` (five for the instance, four with `hosted` for the hosted
API) and four under `routescan/`. Keys are replaced with `[redacted]` and the Standard JSON input
with its length. `test/unit/no-metadata-hash-grades.test.ts` replays them per backend.

## Open questions

- Does Etherscan's explorer page show "Exact Match" for the nohash contract? Not read; see above.
- Should explorer-verify report `exact` for Routescan when Routescan states no grade? This note
  records the behaviour; the issue's non-goals keep the mapping as it is.
