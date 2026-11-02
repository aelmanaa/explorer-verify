# Adoption

Audience: the maintainer and contributors deciding what to build for whom. This page lists who
could use explorer-verify, what each needs from it, and the milestone where that becomes possible.
Requirement IDs refer to [requirements.md](requirements.md), milestones to
[roadmap.md](roadmap.md). Facts about other projects were read on 2026-11-02, with the version or
commit named where they appear.

## Targets

| Target                                | Today                                                                                                       | What explorer-verify adds                                                              | Needs                                             | Possible from                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| Dapps, deploy dashboards, factory UIs | Verification is manual, or a deploy tool runs it on a developer's machine                                   | Verify from the browser after a deployment, with keys kept on the operator's server    | R-FLOW-1 to R-FLOW-5, R-SRV-1 to R-SRV-5, R-RUN-1 | M1 (Sourcify), M3 (server handler)  |
| Protocol SDKs that ship contracts     | Each SDK writes its own verification code                                                                   | One `verify()` call, plus an input builder for whatever compiler JSON the SDK ships    | R-IN-7, R-BE-1 to R-BE-5, R-RUN-4                 | M2 (builder, Etherscan), M4 (0.1.0) |
| thirdweb `verifyContract`             | Verifies contracts whose metadata is on IPFS, on Etherscan-style explorers, Blockscout and Routescan        | Sourcify, caller-supplied input, a time budget and abort for polling, one typed result | R-IN-5, R-BE-1 to R-BE-5, R-FLOW-2 to R-FLOW-4    | M3 (R-IN-5, Blockscout), M4 (0.1.0) |
| Hardhat users                         | `@nomicfoundation/hardhat-verify` verifies on Etherscan-style explorers, Blockscout and Sourcify in Hardhat | A Hardhat 3 plugin on the same core that browsers and backends use                     | R-DX-2, R-IN-7                                    | M4                                  |

R-IN-7, the input builder, is planned in #20 and #21 and added to requirements.md by #20.

### Dapps, deploy dashboards and factory UIs

The main audience. A dapp that deploys a contract for its user calls `verify()` in the browser.
Keyless backends (Sourcify, per-instance Blockscout) work directly. Etherscan goes through the
dapp's own server handler with the operator's own key (decision 0003, R-SEC-3, R-SEC-5).

### Protocol SDKs that ship contracts

An SDK that deploys its own contracts depends on the core and keeps only its artifacts and glue
(decision 0005). The core has no runtime dependencies (R-RUN-4), so adding it adds no transitive
packages to the SDK. The input builder (R-IN-7) accepts build-info, Solidity metadata or a bare
Standard JSON input, so the SDK does not need to know which tool built its artifacts.

First reference user: the Chainlink CCT SDK in
[smartcontractkit/ccip-tools-ts](https://github.com/smartcontractkit/ccip-tools-ts). Two
verification prototypes exist on branches there, and neither is merged (see
[prior-art.md](prior-art.md)). The integration (#25) replaces both with one `verify()` call fed by
the Standard JSON inputs the SDK already ships. Whether to merge it is the SDK maintainers'
decision.

### thirdweb `verifyContract`

What it does, read from the source on 2026-11-02 (`thirdweb` 5.122.1, commit
[`940b3745`](https://github.com/thirdweb-dev/js/commit/940b3745) of thirdweb-dev/js,
`packages/thirdweb/src/contract/verification/index.ts`):

- It takes a `ThirdwebContract`, an explorer API URL and key, optional encoded constructor
  arguments, and a type: `etherscan`, `blockscoutV1`, `blockscoutV2` or `routescan`.
- It reads the IPFS metadata hash from the deployed bytecode and downloads the sources through the
  thirdweb client.
- `checkVerificationStatus` polls every 3 seconds and resolves with the explorer's response.

An issue about the status check's key handling is open as
[thirdweb-dev/js#9049](https://github.com/thirdweb-dev/js/issues/9049), with a proposed fix in
[thirdweb-dev/js#9050](https://github.com/thirdweb-dev/js/pull/9050).

What explorer-verify would add: Sourcify, input from the caller as well as from IPFS, a time budget
and abort for polling, and one typed result across explorers. The plan (#24): once the
bytecode-metadata resolver (R-IN-5) and the Etherscan-family and Blockscout backends exist, offer a
pull request in which `verifyContract` calls explorer-verify and keeps its current signature. This
keeps decision 0001: explorer-verify stays a standalone library and thirdweb's API does not change.
Whether to accept the pull request is thirdweb's decision.

### Hardhat

`@nomicfoundation/hardhat-verify` 3.1.4 (npm, read on 2026-11-02) is Hardhat's own verifier. It
runs inside Hardhat on Node and covers Etherscan-style explorers, Blockscout and Sourcify.
explorer-verify does not aim to replace it. The M4 Hardhat 3 plugin (R-DX-2) gives Hardhat users
the same core that their dapp or backend uses. Whether Hardhat's verifier ever uses the core is its
maintainers' decision.

## Who uses it

No adopter yet. When one lands, add a row: who, which runtime, which backends, since which version,
and a link to the public code or announcement. Add only adopters who agree to be named.

| Adopter | Runtime | Backends | Since | Link |
| ------- | ------- | -------- | ----- | ---- |
