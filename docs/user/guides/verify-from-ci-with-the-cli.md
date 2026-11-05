# Verify from CI with the CLI

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who verify contracts in a CI job, such as a GitHub Actions workflow that runs
after a deployment. Nothing is published to npm yet.

The job builds the contracts, writes the verification request to a file, runs a dry run, then
verifies with `--json` and acts on the exit code. The key comes from a CI secret, in an environment
variable, never from a flag. The [CLI reference](../reference/cli.md) describes every option, and
[Using explorer-verify from an agent](using-from-an-agent.md) the same flow for an agent.

## Setup

Node.js 22.18 or later. Add the CLI, and the helper for your build tool, as development
dependencies:

```bash
npm install --save-dev @explorer-verify/cli @explorer-verify/foundry
```

For Hardhat, install `@explorer-verify/hardhat` in place of `@explorer-verify/foundry`. In CI,
`npm ci --ignore-scripts` installs them from the lockfile, and the workflow below puts `node_modules/.bin` on the
`PATH`, so the steps and the script run `explorer-verify` directly.

## Build and write the request

Build with build-info, so the compiler input is kept as solc received it:

```bash
forge build --build-info
```

For Hardhat, run `npx hardhat build` (Hardhat 3) or `npx hardhat compile` (Hardhat 2).

Then write the request file. This script, `scripts/write-verify-input.ts`, builds the input with
[`buildVerifyInputFromFoundry`](verify-from-a-foundry-project.md), adds the chain and the address from
the environment, checks the whole request with `validateInput()`, and writes `verify-input.json`
with `route.backend`, the explorer to submit to.
For Hardhat, use [`buildVerifyInputFromHardhat`](verify-from-a-hardhat-project.md) the same way. Run it
with `node scripts/write-verify-input.ts`:

```ts
import { writeFile } from "node:fs/promises";

import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";
import { validateInput } from "explorer-verify";

const { CHAIN_ID, CONTRACT_ADDRESS } = process.env;
if (CHAIN_ID === undefined || CONTRACT_ADDRESS === undefined) {
  throw new Error("Set CHAIN_ID and CONTRACT_ADDRESS.");
}
const built = await buildVerifyInputFromFoundry({ root: ".", contract: "src/Greeter.sol:Greeter" });
// Throws invalid-input, naming each bad field, before the CLI runs.
const request = validateInput({ ...built, chainId: Number(CHAIN_ID), address: CONTRACT_ADDRESS });
// verify submits only where the request says: a backend, or "auto" for the routing table's pick.
await writeFile(
  "verify-input.json",
  JSON.stringify({ ...request, route: { backend: "sourcify" } }),
);
console.log(`verify-input.json: ${request.contractName} on chain ${String(request.chainId)}`);
```

With `CHAIN_ID=11155111` and the Greeter's address, it prints:

```text
verify-input.json: src/Greeter.sol:Greeter on chain 11155111
```

The file holds no key: the request has no field for one. `--input-json` reads it, and
`explorer-verify` ships its JSON Schema as `explorer-verify/input.schema.json`
([The request as JSON](../reference/cli.md#the-request-as-json)). You can also pass the build files
with `--input` and the address and chain as arguments; Foundry and Hardhat name build-info files by
a hash, so the script is simpler in a job.

## Dry run first

A dry run validates the request, resolves the explorer and looks the contract up, and never
submits. It needs no key:

```sh
# exit code 0
explorer-verify verify --input-json verify-input.json --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"caller"}}
```

`backend` names the explorer the real run will use, and `routedBy` says how it was chosen. With
`route.backend` set to `"auto"`, the routing table picks it partly by the keys set, so run the dry
run with the same environment as the real run. Without `route.backend`, the real run exits 2 and
submits nothing. `lookup` tells what the real
run will do:

- `exact` or `partial`: the explorer already holds the contract. The run submits nothing.
- `none`: the run will submit.
- `skipped`: the backend needs a key and none is set, so no request was sent. The real run exits
  3 with `missing-api-key`. Check the secret.

## Verify and read the outcome

With `--json`, stdout holds exactly one line, the
[JSON envelope](../reference/json-output.md#the-envelope), and logs go to stderr:

```sh
# exit code 0
explorer-verify verify --input-json verify-input.json --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"already-verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

Read fields with `jq`, such as `jq -r '.result.status'`, `.error.code` or `.error.handle`. GitHub's
Ubuntu runners include jq
([Ubuntu 24.04 image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md),
version 20261026, read on 2026-11-04).

## Act on the exit code

`scripts/verify.sh` runs the command and branches on the exit code. It writes the handle of a
pending job as a step output, `handle`, so a later job can resume it, and it fails the step on
every other code but 0. It needs `bash` and `jq`:

```bash
#!/usr/bin/env bash
# Verifies the request in $1. Exit codes: https://aelmanaa.github.io/explorer-verify/reference/json-output
set -uo pipefail

# Escapes text from an explorer for a workflow command line: %, CR and LF.
escape() {
  local text=$1
  text=${text//'%'/'%25'}
  text=${text//$'\r'/'%0D'}
  text=${text//$'\n'/'%0A'}
  printf '%s' "$text"
}

envelope=$(explorer-verify verify --input-json "$1" --json --timeout "${VERIFY_TIMEOUT:-300}")
code=$?

case "$code" in
  0)
    echo "$(jq -r '.result.status' <<<"$envelope") on $(jq -r '.result.backend' <<<"$envelope")"
    ;;
  4)
    handle=$(jq -r '.error.handle // empty' <<<"$envelope")
    if [ -n "$handle" ]; then
      echo "::warning::No verdict yet. Resume with: explorer-verify status $(escape "$handle")"
      echo "handle=$handle" >>"${GITHUB_OUTPUT:-/dev/null}"
      exit 0
    fi
    echo "::error::$(escape "$(jq -r '.error.code + ": " + .error.hint' <<<"$envelope")")"
    ;;
  1)
    echo "::error::The explorer rejected the source: $(escape "$(jq -r '.result.reason' <<<"$envelope")")"
    ;;
  2 | 3 | 5 | 6 | 130)
    echo "::error::$(escape "$(jq -r '.error.code + ": " + .error.hint' <<<"$envelope")")"
    ;;
  *)
    echo "::error::explorer-verify exited with $code"
    ;;
esac
exit "$code"
```

| Exit code | Outcome                                                       | What the script does                                                                                            |
| --------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0         | `verified` or `already-verified`                              | Prints the status and the backend                                                                               |
| 1         | `failed`: the explorer rejected the source                    | Fails with the reason. Fix the build, not the job                                                               |
| 2         | Usage or input error; nothing was submitted                   | Fails with the code and the hint                                                                                |
| 3         | API key missing, rejected or out of quota                     | Fails with the hint. Check the secret                                                                           |
| 4         | `not-confirmed` with a handle, or `verification-inconclusive` | With a handle: passes, warns and writes the `handle` output. Without one: fails; run `verify` again later, once |
| 5         | Network or explorer unavailable after retries                 | Fails. Re-run the job later: `verify` looks the contract up before it submits                                   |
| 6         | `unknown-state`, `job-not-found` or `internal-error`          | Fails. Do not re-run automatically; read the hint                                                               |
| 130       | Cancelled                                                     | Fails. If the log shows a `Submitted` line, resume its handle with `status`                                     |

The script reads the envelope even when the command fails, because `set -e` is off: with `set -e`,
the failing command substitution would end the script before `case`. `${VERIFY_TIMEOUT:-300}`
gives the run five minutes; a run that ends pending exits 4 with the handle. `escape` encodes `%`,
CR and LF in text that comes from an explorer, as `%25`, `%0D` and `%0A`, so a reason or hint
cannot end the `::error::` line and start another workflow command. These are the escapes that
GitHub's own `@actions/core` applies to a command's message
([`escapeData` in command.ts](https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts),
read on 2026-11-04). Each code's errors are listed in
[Errors](../reference/errors/index.md#exit-codes).

## Resume a pending job

Resume a handle with `status`, never with a new `verify`. It polls the job and never submits, with
the same exit codes. Pass the same route and keys the submit used:

```sh
# exit code 0
explorer-verify status ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718 --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

## Keys from CI secrets

Store the key as a repository or environment secret, and pass it in `env` to the steps that run
the CLI, and to no other step. The CLI reads `ETHERSCAN_API_KEY`, `ROUTESCAN_API_KEY` and `BLOCKSCOUT_API_KEY`, and no
flag takes a key as its value: a key on the command line shows in the process list and the shell
history. GitHub's docs also advise against passing secrets on the command line
([Using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets),
read on 2026-11-04).

A workflow that verifies after a deployment on Sepolia:

```yaml
name: Verify
on:
  workflow_dispatch:
    inputs:
      address:
        description: The deployed contract's address
        required: true

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-24.04
    outputs:
      # The handle of a job still pending, for a later job: needs.verify.outputs.handle.
      handle: ${{ steps.verify.outputs.handle }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - uses: foundry-rs/foundry-toolchain@dba66c27052e63476d886f22216e119ba7e615bf # v1.9.2
      - run: npm ci --ignore-scripts
      # Puts explorer-verify on the PATH of the later steps.
      - run: echo "$PWD/node_modules/.bin" >>"$GITHUB_PATH"
      - run: forge build --build-info
      - run: node scripts/write-verify-input.ts
        env:
          CHAIN_ID: "11155111"
          CONTRACT_ADDRESS: ${{ inputs.address }}
      - run: explorer-verify verify --input-json verify-input.json --dry-run --json
        env:
          ETHERSCAN_API_KEY: ${{ secrets.ETHERSCAN_API_KEY }}
      - id: verify
        run: bash scripts/verify.sh verify-input.json
        env:
          ETHERSCAN_API_KEY: ${{ secrets.ETHERSCAN_API_KEY }}
```

- The input goes into the script through `env`, not into the `run` line, so a crafted value cannot
  change the shell command.
- `npm ci --ignore-scripts` runs no install script, and no step before the dry run has the key, so
  install scripts never see it. The key is still in the environment of the steps that run
  `explorer-verify`, with the code your lockfile installed: trust your lockfile.
- Each action is pinned to a full commit SHA, with its version in a comment, and `checkout` does
  not keep the repository token in the Git configuration.
- A workflow that a pull request from a fork triggers gets no secrets
  ([Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
  read on 2026-11-04). Without a key, the call goes to the first backend of the chain's row that
  needs none, such as Sourcify, or exits 3 with `missing-api-key` when the row has none. The dry
  run's `backend` and `lookup` show which.
- The `handle` output carries the handle of a job still pending. A later job that `needs: verify`
  reads it as `needs.verify.outputs.handle` and runs `explorer-verify status` with it.
- The CLI removes every key it read from stdout and stderr, as `[redacted]`. GitHub masks
  secrets in the log as well.

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. Free plans cover personal use, such as a developer verifying their
own testnet deployments. See [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md).

## What is tested

The CLI's integration tests run the `sh` examples on this page against the built command, in a
Foundry project with a fake explorer, and check each exit code and stdout. They run
`scripts/verify.sh` with `bash` and `jq` for exit codes 0, 2, 3 and 4, and check that it escapes
`%`, CR and LF in a hint. The repository's docs test
runs the TypeScript script in a Foundry project. The workflow itself is not run.
