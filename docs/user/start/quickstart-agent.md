# Quickstart: AI agent

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: people who let a coding agent verify a contract.

You need: an agent with a shell, Node.js 22.18 or later, and the contract's
Foundry or Hardhat build.

## Paste the prompt

Paste this into your agent and fill in the three values:

```text [prompt.txt]
Verify my contract with explorer-verify.
Address: <address>. Chain ID: <chain-id>. Contract: <path:Name>.

1. Read https://aelmanaa.github.io/explorer-verify/llms.txt and the
   pages its Instructions section lists.
2. Test the tool on the docs' sample. This submits nothing. Download
https://aelmanaa.github.io/explorer-verify/start/greeter-sepolia.json
and run:
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
3. Dry-run my contract from this project's build: --foundry . or
   --hardhat ., with --contract, --dry-run and --json.
4. Show me the backend, lookup and status, then stop. A run without
   --dry-run publishes the source for good.
5. Submit only after I say yes. Read keys from the environment;
   never print one.
```

## Check the dry run

The agent's first command needs no key:

```sh [dry-run.sh]
# exit code 0
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

`status: "dry-run"`: nothing was sent. `lookup: "exact"`: Sourcify already
holds this sample.

## Approve the submit

The agent stops after the dry run of your contract. Check the backend,
then reply yes. The real run drops `--dry-run`.

> [!WARNING]
> A submit cannot be undone.

## Next steps

- [Using explorer-verify from an agent](../guides/using-from-an-agent.md):
  safe calls and keys.
- [Agent skill](../../../skills/explorer-verify/SKILL.md).
- [JSON output and exit codes](../reference/json-output.md).
- [Errors](../reference/errors/index.md).
