# Quickstart: a Foundry project

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who deploy with Foundry and want to verify from the command line.

You need: Node.js 22.12 or later, Foundry and curl. No API key.

The command ships in `@explorer-verify/cli`. `npx` runs it, so the project gains no dependency.

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

`lookup` is `exact`: the explorer holds the contract, so a real run submits nothing.

## 3. Build your project

Build with build-info, so the CLI reads the compiler input as solc received it:

```bash
forge build --build-info
```

## 4. Dry run your contract

Pass `--foundry .` and the contract as `path:Name`, with your address and chain ID:

```sh
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter \
  --backend sourcify --dry-run --json
```

It exits 0 and prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"caller"}}
```

`lookup` is `none` when the explorer does not hold your contract yet: the real run will submit.

## 5. Verify for real

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

- [Verify a contract from a Foundry project](../guides/verify-from-a-foundry-project.md): the
  library helper and the files it reads.
- [Verify from CI with the CLI](../guides/verify-from-ci-with-the-cli.md): keys and exit codes.
- [CLI reference](../reference/cli.md): every command and option.
