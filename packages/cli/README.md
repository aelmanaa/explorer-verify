# @explorer-verify/cli

Verify deployed smart-contract source on Etherscan, Blockscout, Sourcify and Routescan from a terminal.

Status: experimental before 1.0. The API may change before 1.0. Requires Node.js 22.18 or later.

In a Foundry project, first run `forge build --build-info`. These commands use its Greeter
build and the deployed address on Sepolia; replace the address and contract with your deployment.
The dry run reads the explorer. The second command can publish source. Output below is from an
already verified contract; progress goes to stderr.

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain sepolia --foundry . --contract src/Greeter.sol:Greeter --backend sourcify --dry-run
# exit code 0
```

```text
dry run on sourcify at sourcify.dev: exact match already, so a run without --dry-run would not submit.
https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain sepolia --foundry . --contract src/Greeter.sol:Greeter --backend sourcify
# exit code 0
```

```text
already-verified: exact match on sourcify
https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

Use `--json` for one stdout envelope and documented exit codes; logs stay on stderr.
See the [CLI reference](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/cli.md)
and [CI guide](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-ci-with-the-cli.md).
