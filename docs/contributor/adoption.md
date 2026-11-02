# Adoption

Audience: the maintainer and contributors deciding what to build for whom. Requirement IDs refer to
[requirements.md](requirements.md), milestones to [roadmap.md](roadmap.md).

## Goal

One SDK and one CLI for verifying contracts, usable by any tooling: dapps in a browser, backends and
edge runtimes, CI jobs, deploy tools and frameworks, and SDKs that ship contract artifacts. Each
kind of user calls the same core. Plugins for deploy tools are thin layers on that core.

## Users and what they need

| User                                   | Needs                                                      | Possible from                            |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| Dapps in a browser                     | R-FLOW-1 to R-FLOW-5, R-RUN-1, R-SRV-1 to R-SRV-5, R-SEC-5 | M1 (Sourcify), M3 (server handler)       |
| Backends and edge runtimes             | R-FLOW-1 to R-FLOW-6, R-RUN-1, R-BE-1 to R-BE-5            | M1 (Sourcify), M2 (Etherscan family)     |
| CI jobs                                | R-DX-1, R-AX-5 to R-AX-12                                  | M4                                       |
| Deploy tools and frameworks            | R-DX-2, R-IN-7                                             | M2 (builder), M4 (Foundry and Hardhat 3) |
| SDKs that ship contract artifacts      | R-IN-7, R-RUN-4, R-RUN-5, R-BE-1 to R-BE-5                 | M2 (builder, Etherscan), M3 (Blockscout) |
| Tools that hold only deployed bytecode | R-IN-5                                                     | M3                                       |

R-IN-7, the input builder, is planned in #20 and #21 and added to requirements.md by #20.

### Dapps in a browser

This is the main audience. A dapp that deploys a contract for its user calls `verify()` in the
browser. Keyless backends (Sourcify, per-instance Blockscout) work directly. Etherscan goes through
the dapp's own server handler with the operator's own key (decision 0003, R-SEC-3, R-SEC-5).

### Backends and edge runtimes

A deployment service calls the same `verify()` with its own keys. The core uses only web-platform
globals (R-RUN-1), so it runs unchanged in Node, Deno, Bun and edge runtimes. A pending
verification resumes from a handle in another process (R-FLOW-5).

### CI jobs

A CI job runs the CLI after a deployment. It reads the JSON envelope and the exit code, and resumes
a pending verification with `explorer-verify status <handle>` (R-AX-5 to R-AX-7).

### Deploy tools and frameworks

A deploy tool or framework adds verification as a plugin built on the core. The plugin locates its
build files and passes them to the input builder (R-IN-7); it holds no explorer logic. The M4 build
helpers for Foundry and Hardhat 3 (R-DX-2) are the first such plugins.

### SDKs that ship contract artifacts

An SDK that deploys its own contracts depends on the core and keeps only its artifacts and glue
(decision 0005). The core has no runtime dependencies (R-RUN-4), so adding it adds no transitive
packages. The input builder (R-IN-7) accepts build-info, Solidity metadata or a bare Standard JSON
input, so the SDK does not need to know which tool built its artifacts.

### Tools that hold only deployed bytecode

A tool without the compiler input verifies through the bytecode-metadata resolver (R-IN-5): it
reads the metadata hash in the deployed bytecode and rebuilds the input from the published metadata
and sources.

## Who uses it

No adopter yet. The table is empty on purpose. To be listed, a project opens a pull request that
adds its row: who, which runtime, which backends, since which version, and a link to the public code
or announcement. A row is added only with the adopter's consent: the adopter opens or approves that
pull request, or the link is the adopter's own public statement.

| Adopter | Runtime | Backends | Since | Link |
| ------- | ------- | -------- | ----- | ---- |
