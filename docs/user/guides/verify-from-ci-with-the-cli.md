# Verify from CI with the CLI

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who verify contracts in a CI job, such as a GitHub Actions workflow that runs
after a deployment.

You need: Node.js 22.18 or later, a Foundry or Hardhat project, and the deployed contract's address
and chain. An API key only for an explorer that needs one, such as Etherscan.

The job builds the contracts, dry runs the verification, then verifies with `--json` and acts on
the exit code. The key comes from a CI secret, in an environment variable, never from a flag.

## Install the CLI

Add the CLI as a development dependency, so CI runs the version in your lockfile:

```bash
npm install --save-dev @explorer-verify/cli
```

In CI, `npm ci --ignore-scripts` installs it from the lockfile. Every step then runs
`npx @explorer-verify/cli`, which uses the installed copy.

## Build with build-info

Build so that the compiler input is kept as solc received it:

```bash
forge build --build-info
```

For Hardhat, run `npx hardhat build` (Hardhat 3) or `npx hardhat compile` (Hardhat 2). Then pass
`--hardhat .` and the contract's path, such as `contracts/Greeter.sol:Greeter`.
[Projects and build files](../reference/cli.md#projects-and-build-files) covers other layouts.

## Dry run first

A dry run validates the input, resolves the explorer and looks the contract up. It never submits,
and it needs no key:

```sh [dry-run.sh]
# exit code 0
npx @explorer-verify/cli verify \
  0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 \
  --foundry . \
  --contract src/Greeter.sol:Greeter \
  --backend sourcify \
  --dry-run \
  --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"caller"}}
```

Check three fields of the envelope:

| Field      | What it tells you                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backend`  | The explorer the real run will use                                                                                                                                                                                 |
| `routedBy` | How it was chosen: `caller` for `--backend`, `table` for the routing table's pick                                                                                                                                  |
| `lookup`   | `exact` or `partial`: the explorer holds the contract, so the run submits nothing. `none`: the run will submit. `skipped`: the backend needs a key and none is set, so the real run exits 3 with `missing-api-key` |

> [!TIP]
> With `--backend auto`, the routing table picks the backend partly by the keys set. Dry run in the
> same environment as the real run. Without any `--backend`, the real run exits 2.

## Verify and read the outcome

Drop `--dry-run`. With `--json`, stdout holds one line, the
[JSON envelope](../reference/json-output.md#the-envelope), and logs go to stderr:

```sh
# exit code 0
npx @explorer-verify/cli verify \
  0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 \
  --foundry . \
  --contract src/Greeter.sol:Greeter \
  --backend sourcify \
  --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"already-verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

Read fields with `jq`, such as `jq -r '.result.status'`, `.error.code` or `.error.handle`.
GitHub's Ubuntu runners include jq.

## Act on the exit code

`scripts/verify.sh` runs `verify` with the arguments it is given, adds `--json`, and branches on
the exit code. It needs `bash` and `jq`:

```bash [scripts/verify.sh]
#!/usr/bin/env bash
# Runs explorer-verify verify with the given arguments. Exit codes:
# https://aelmanaa.github.io/explorer-verify/reference/json-output
set -uo pipefail

# Escapes text from an explorer for a workflow command: %, CR and LF.
escape() {
  local text=$1
  text=${text//'%'/'%25'}
  text=${text//$'\r'/'%0D'}
  text=${text//$'\n'/'%0A'}
  printf '%s' "$text"
}

# Reads one field of the envelope.
field() {
  jq -r "$1" <<<"$envelope"
}

# The error's code, message and hint, escaped.
problem() {
  local text
  text=$(field '.error.code + ": " + .error.message + " " + .error.hint')
  escape "$text"
}

envelope=$(npx @explorer-verify/cli verify "$@" \
  --json --timeout "${VERIFY_TIMEOUT:-300}")
code=$?

case "$code" in
  0)
    echo "$(field .result.status) on $(field .result.backend)"
    ;;
  4)
    handle=$(field '.error.handle // empty')
    if [ -n "$handle" ]; then
      resume="npx @explorer-verify/cli status $(escape "$handle")"
      echo "::warning::No verdict yet. Resume with: $resume"
      echo "handle=$handle" >>"${GITHUB_OUTPUT:-/dev/null}"
      exit 0
    fi
    echo "::error::$(problem)"
    ;;
  1)
    reason=$(escape "$(field .result.reason)")
    echo "::error::The explorer rejected the source: $reason"
    ;;
  2 | 3 | 5 | 6 | 130)
    echo "::error::$(problem)"
    ;;
  *)
    echo "::error::explorer-verify exited with $code"
    ;;
esac
exit "$code"
```

| Exit code | Outcome                                                                     | What the script does                                                        |
| --------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 0         | `verified` or `already-verified`                                            | Prints the status and the backend                                           |
| 1         | `failed`: the explorer rejected the source                                  | Fails with the reason. Fix the build, not the job                           |
| 2         | Usage or input error; nothing was submitted                                 | Fails with the code, the message and the hint                               |
| 3         | API key missing, rejected or out of quota                                   | Fails with the hint. Check the secret                                       |
| 4         | `not-confirmed` with a handle, `verification-inconclusive` or `not-indexed` | With a handle: passes, warns and writes the `handle` output. Without: fails |
| 5         | Network or explorer unavailable after retries                               | Fails. Re-run the job later: `verify` looks the contract up first           |
| 6         | `unknown-state`, `job-not-found` or `internal-error`                        | Fails. Do not re-run automatically; read the hint                           |
| 130       | Cancelled                                                                   | Fails. If the log shows a `Submitted` line, resume its handle               |

The script leaves `set -e` off on purpose. With it, the failing command substitution would end the
script before `case`, and the envelope would go unread.

`${VERIFY_TIMEOUT:-300}` gives the run five minutes. A run that ends pending exits 4 with the
handle, and the script writes it as the step output `handle`.

A job that verifies right after the deploy can reach Etherscan before it has indexed the contract.
Etherscan then answers that it finds no contract code at the address, and `verify` sends the
submit again at most 10 times, about 27 seconds at the default `--poll-interval` of 3 seconds.
Pass `--index-wait <seconds>` to keep sending it longer, such as `--index-wait 120`. The wait stays
within `--timeout`. When it ends, the run exits 4 with `not-indexed` and no handle.

`escape` encodes text from an explorer. `%` becomes `%25`, and CR and LF become `%0D` and `%0A`.
So a reason or a hint cannot end the `::error::` line and start another workflow command. GitHub's own
`@actions/core` applies the same escapes. [Errors](../reference/errors/index.md#exit-codes) lists
each code's errors.

## Resume a pending job

Resume a handle with `status`, never with a new `verify`. It polls the job and never submits, with
the same exit codes. Pass the route and keys the submit used. `HANDLE` holds the handle:

```sh
# exit code 0
npx @explorer-verify/cli status "$HANDLE" --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

## Keep the key in a CI secret

Store the key as a repository or environment secret. Pass it in `env` to the steps that run the
CLI, and to no other step. The CLI reads `ETHERSCAN_API_KEY`, `ROUTESCAN_API_KEY` and
`BLOCKSCOUT_API_KEY`.

No flag takes a key as its value: a key on the command line shows in the process list and the
shell history. GitHub's docs also advise against passing secrets on the command line.

> [!IMPORTANT]
> A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan
> Advanced plan or higher and its own key. See
> [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md).

## Run it in GitHub Actions

This workflow verifies a contract on Sepolia after a deployment. It runs the dry run, then the
script:

```yaml [.github/workflows/verify.yml]
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
      # The handle of a job still pending: needs.verify.outputs.handle.
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
      - run: forge build --build-info
      - run: >-
          npx @explorer-verify/cli verify "$CONTRACT_ADDRESS"
          --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter
          --backend sourcify --dry-run --json
        env:
          CONTRACT_ADDRESS: ${{ inputs.address }}
          ETHERSCAN_API_KEY: ${{ secrets.ETHERSCAN_API_KEY }}
      - id: verify
        run: >-
          bash scripts/verify.sh "$CONTRACT_ADDRESS"
          --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter
          --backend sourcify
        env:
          CONTRACT_ADDRESS: ${{ inputs.address }}
          ETHERSCAN_API_KEY: ${{ secrets.ETHERSCAN_API_KEY }}
```

- The address reaches the steps through `env`, not the `run` line, so a crafted value cannot
  change the shell command.
- `npm ci --ignore-scripts` runs no install script, and no step before the dry run has the key.
  The steps that run the CLI still have it, with the code your lockfile installed: trust your
  lockfile.
- Each action is pinned to a full commit SHA, with its version in a comment. `checkout` does not
  keep the repository token in the Git configuration.
- A workflow that a pull request from a fork triggers gets no secrets. Without a key, the call goes
  to the first backend of the chain's row that needs none, such as Sourcify. If the row has none,
  it exits 3 with `missing-api-key`.
- A later job that `needs: verify` reads the handle as `needs.verify.outputs.handle`, and runs
  `npx @explorer-verify/cli status` with it.
- The CLI removes every key it read from stdout and stderr, as `[redacted]`. GitHub masks secrets
  in the log as well.

## What is tested

The CLI's integration tests run the `sh` examples on this page against the built command, in a
Foundry project with a fake explorer. They check each exit code and stdout. They run
`scripts/verify.sh` with `bash` and `jq` for exit codes 0, 2, 3 and 4, and check that it escapes
`%`, CR and LF in a hint. The workflow itself is not run.

## Sources

- jq on GitHub's Ubuntu runners:
  [Ubuntu 24.04 image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md),
  version 20261026, read on 2026-11-04.
- The escapes of `@actions/core`:
  [`escapeData` in command.ts](https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts),
  read on 2026-11-04.
- Secrets on the command line:
  [Using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets),
  read on 2026-11-04.
- Secrets in workflows from forks:
  [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
  read on 2026-11-04.

## Next steps

- [CLI reference](../reference/cli.md): every option, the submit target and API key flags.
- [CLI output](../reference/cli-output.md): stdout, stderr, log levels and cancelling.
- [JSON output and exit codes](../reference/json-output.md): the envelope fields.
- [Errors](../reference/errors/index.md): what to do for each error code.
- [Using explorer-verify from an agent](using-from-an-agent.md): the same flow for an agent.
