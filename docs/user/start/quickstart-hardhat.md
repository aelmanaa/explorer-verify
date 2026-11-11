# Quickstart: a Hardhat project

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who deploy with Hardhat and want to verify from the command line.

You need: Node.js 22.18 or later, a Hardhat 3 or Hardhat 2 project and curl. No API key.

This is not a Hardhat plugin: `@explorer-verify/cli` reads the build files under `artifacts/`
and needs no change to `hardhat.config.ts`. It works alongside `hardhat-verify`.

## 1. Download the sample request

The sample is a Greeter that Sourcify already verified on Sepolia:

```bash
curl -fsSLO \
  https://raw.githubusercontent.com/aelmanaa/explorer-verify/main/docs/user/start/greeter-sepolia.json
```

## 2. Dry run it

A dry run looks the contract up and never submits:

```sh
# exit code 0
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

`lookup` is `exact`: the explorer holds the contract, so a real run submits nothing.

## 3. Build your project

Build with your deploy profile. Hardhat Ignition uses `production`:

```bash
npx hardhat build --build-profile production
```

On Hardhat 2, run `npx hardhat compile`.

## 4. Dry run your contract

Pass `--hardhat .` and the contract as `path:Name`, with your address and chain ID:

```sh
# exit code 0
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --hardhat . --contract contracts/Greeter.sol:Greeter \
  --backend sourcify --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"caller"}}
```

`lookup` is `none` when the explorer does not hold your contract yet: the real run will submit.

## 5. Verify for real

Drop `--dry-run`:

```sh
# exit code 0
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --hardhat . --contract contracts/Greeter.sol:Greeter \
  --backend sourcify --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"already-verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

> [!WARNING]
> A submit publishes your source and cannot be undone. Run the dry run first.

## Next steps

- [Verify a contract from a Hardhat project](../guides/verify-from-a-hardhat-project.md): the
  library helper and the deploy profile.
- [Verify from CI with the CLI](../guides/verify-from-ci-with-the-cli.md): keys and exit codes.
- [CLI reference](../reference/cli.md): every command and option.
