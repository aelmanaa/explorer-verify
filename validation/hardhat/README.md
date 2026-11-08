# Hardhat task validation

Issue #266, parent #263. This independent local consumer validates the packed
0.1.0 candidate at `df036c7245c1baefa869478c7a5a00ca5366d8a2`.
It is validation code, not an upstream adoption claim.

Run from the repository root with Node 24 and npm, registry access for the locked
Hardhat dependencies, and the official candidate tarballs:

```sh
node validation/hardhat/run.mjs --tarballs <candidate-tarballs> --output validation/hardhat/results
```

The runner copies the project and two tarballs into a fresh temporary installation,
uses `npm ci --ignore-scripts`, typechecks the task, and invokes the actual Hardhat
3.21.2 CLI. solc 0.8.24 comes from the pinned npm dependency; no compiler download
is needed. `project/package-lock.json` pins transitive dependencies. The output
includes JSON scenarios, candidate tarball SHA-256 hashes and the installation lock.
Temporary installations are retained for inspection. No credentials are needed.

The project sets `paths.artifacts` to `build/artifacts`. The task passes that resolved
Hardhat configuration path to `buildVerifyInputFromHardhat`; the helper does not
load config or compile. Builds explicitly select default and production profiles.
The runner asserts optimizer settings in the actual HTTP submission, including
Hardhat 3's `project/` source prefix. The task verifies the existing build and does
not silently rebuild under a different profile.

The loopback Sourcify v2 stand-in returns synthetic exact matches, permanent
`no_match` rejection, and pending jobs. A serialized handle resumes in a separate
Hardhat CLI process without another submission. Removing real compiler output
files produces `incomplete-input` before network access; restoring those files
recovers verification. Expected rejection, incomplete-input and pending `not-confirmed` exits are 1;
verified exits are 0. Pending is a typed SDK error with a resumable handle, not a
`pending` result status. JSON `success` means each expected outcome was observed.

Limits: there is no deployment or chain bytecode check here. The address is a
synthetic target and explorer verdicts are synthetic. This proves compilation,
artifact/config boundaries, SDK delegation and process resume, not acceptance by
Sourcify or another live explorer. Only Hardhat 3 is exercised. This task is not a
replacement with full parity for `@nomicfoundation/hardhat-verify`: it does not
infer deployment network/address, encode arbitrary constructor values, discover
library addresses, choose a deployment profile, minimize compiler input, link
proxies or support Ignition integration. Constructor arguments are fixed for this
Counter fixture. Missing build files recover by restoration/rebuilding with the
deployment profile; this task does not perform bytecode metadata recovery. The
SDK exposes `buildVerifyInputFromBytecode` separately; the existing product CLI
has no address-only recovery command.

Source attribution: Counter and runner/task glue are original validation code.
Hardhat artifact layout and profile behavior follow the repository's
`docs/contributor/research/2026-11-03-hardhat-build-layout.md` and
`docs/user/guides/verify-from-a-hardhat-project.md`. Synthetic HTTP shapes follow
Sourcify v2 and the repository's recorded Sourcify fixtures; no fixture claims a
new live observation. Hardhat and solc dependencies retain their package licenses.

Recorded result: all 10 scenarios passed on Node v24.21.0. See
`results/results.json` for expected failure exits, the saved handle, submitted
compiler input digests and candidate tarball hashes. Strict TypeScript checking
and `node --check validation/hardhat/run.mjs` passed. Initial validation corrected
local glue errors: a relative solc module path, an unavailable public error guard,
a poll budget below the SDK's one-second minimum interval, and treating a handle's
JSON text as its compact wire form. The task now uses `ExplorerVerifyError`,
`validateInput`, and `formatHandle` from the public SDK. No product files changed.

Repository integration checks the runner, while the temporary consumer runs its own strict
TypeScript check against installed Hardhat and SDK declarations. The shared tarball inspector
selects the supplied versions. The temporary lock binds those local SDK entries to the supplied
versions and integrity, preserving the pinned external dependencies. Committed evidence records
the original 0.1.0 run; later runs record their actual package versions and gitHead.
