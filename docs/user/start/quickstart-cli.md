# Quickstart: the CLI

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who verify contracts from a terminal or a CI job.

You need: Node.js 22.12 or later and curl. No API key, wallet or project.

The command ships in `@explorer-verify/cli`. `npx` downloads and runs it.

## 1. Download the sample request

The sample is a Greeter that Sourcify already verified on Sepolia:

```bash
repo=https://raw.githubusercontent.com/aelmanaa/explorer-verify/main
curl -fsSLO "$repo/docs/user/start/greeter-sepolia.json"
```

## 2. Dry run it

A dry run looks the contract up and never submits:

```sh
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
```

It exits 0 and prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

`lookup` is `exact`: the explorer holds the contract, so a real run submits nothing. With
`ETHERSCAN_API_KEY` set, `backend` reads `etherscan-v2` instead.

## 3. Point it at your project

In a Foundry project, build with build-info, then name the address, chain and contract:

```bash
forge build --build-info
```

```sh
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter \
  --backend sourcify --dry-run --json
```

It exits 0 and prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"caller"}}
```

Use your own address, chain and contract. In a Hardhat project, run `npx hardhat build` and pass
`--hardhat .` instead.

## 4. Verify for real

Drop `--dry-run`:

```sh
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter \
  --backend sourcify --json
```

It exits 0 and prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"already-verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

> [!WARNING]
> A submit publishes your source and cannot be undone. Run the dry run first.

## Next steps

- [Verify from CI with the CLI](../guides/verify-from-ci-with-the-cli.md): the workflow, keys
  from CI secrets and the exit codes.
- [CLI reference](../reference/cli.md): every command and option.
- [JSON output and exit codes](../reference/json-output.md): the envelope fields.
