# explorer-verify documentation

Verify the source of a deployed contract on Etherscan, Blockscout, Sourcify and Routescan, from a
browser, a backend, a CI job or an agent.

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../llms.txt) lists every page of these docs.

Start with the [quickstart for your setup](start/README.md), or read
[which package you need](start/which-package.md).

## Try it with no key

[start/greeter-sepolia.json](start/greeter-sepolia.json) is a sample request for a Greeter that
Sourcify already verified on Sepolia. A dry run looks it up and submits nothing:

```sh
curl -fsSLO https://raw.githubusercontent.com/aelmanaa/explorer-verify/main/docs/user/start/greeter-sepolia.json
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

`lookup` is `exact`: the explorer already holds the contract, so a real run would submit nothing.
With `ETHERSCAN_API_KEY` set, the routing table picks Etherscan instead.

## Start here

| You are building            | Install                             | Quickstart                                     |
| --------------------------- | ----------------------------------- | ---------------------------------------------- |
| A browser dapp              | `npm i explorer-verify`             | [Browser dapp](start/quickstart-browser.md)    |
| A Node.js script or backend | `npm i explorer-verify`             | [Node.js script](start/quickstart-node.md)     |
| A terminal or CI job        | nothing: `npx @explorer-verify/cli` | [The CLI](start/quickstart-cli.md)             |
| A Foundry project           | nothing: `npx @explorer-verify/cli` | [Foundry project](start/quickstart-foundry.md) |
| A Hardhat project           | nothing: `npx @explorer-verify/cli` | [Hardhat project](start/quickstart-hardhat.md) |
| An SDK or tool for others   | `npm i explorer-verify`             | [SDK wrapper](start/quickstart-sdk-wrapper.md) |
| A task for an AI agent      | nothing: the agent runs `npx`       | [AI agent](start/quickstart-agent.md)          |

[All quickstarts](start/README.md) lists the seven with one line each.

## The four packages

| Package                    | What it does                                       | Use it when                              |
| -------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `explorer-verify`          | Verify, dry run, resume and link a proxy from code | Your code calls the explorers            |
| `@explorer-verify/cli`     | The `explorer-verify` command, with JSON output    | A terminal, a CI job or an agent runs it |
| `@explorer-verify/foundry` | Builds the input from a Foundry project's `out/`   | Node.js code works in a Foundry project  |
| `@explorer-verify/hardhat` | Builds the input from a Hardhat 2 or 3 project     | Node.js code works in a Hardhat project  |

[Which package do I need](start/which-package.md) gives the install command and the entry for
each task.

## Find your way

- Tutorials: [verify from a dapp](tutorials/verify-from-a-dapp.md) with no wallet, and
  [deploy and verify from a dapp](tutorials/deploy-and-verify-from-a-dapp.md).
- Guides by setup: [Node.js](guides/verify-from-node.md), [browser](guides/verify-from-a-browser.md),
  [edge function](guides/verify-from-an-edge-function.md),
  [CI with the CLI](guides/verify-from-ci-with-the-cli.md),
  [Foundry](guides/verify-from-a-foundry-project.md),
  [Hardhat](guides/verify-from-a-hardhat-project.md) and
  [the server handler](guides/run-the-server-handler.md).
- Guides by task: [a proxy](guides/verify-a-proxy.md),
  [from deployed bytecode](guides/verify-from-deployed-bytecode.md),
  [a contract from an npm package](guides/verify-a-contract-from-an-npm-package.md) and
  [contracts your package ships](guides/verify-contracts-your-package-ships.md).
- Advanced: [wrap it in your tool](guides/wrap-explorer-verify-in-your-tool.md),
  [use it from an agent](guides/using-from-an-agent.md), [the core entry](reference/core.md),
  [bundle size](advanced/bundle-size.md),
  [several explorers](advanced/verify-on-several-explorers.md),
  [abort and resume](advanced/abort-and-resume.md),
  [resume from a job queue](advanced/resume-from-a-job-queue.md) and
  [logging and events](reference/logging-and-events.md).
- Reference: [verify()](reference/verify.md), [checkStatus()](reference/check-status.md),
  [CLI](reference/cli.md), [CLI output](reference/cli-output.md),
  [JSON output and exit codes](reference/json-output.md), [API keys](reference/api-keys.md),
  [routing](reference/routing.md), [server handler](reference/server-handler.md) and
  [errors](reference/errors/index.md).
- Explorers: [Sourcify](reference/sourcify.md), [Etherscan](reference/etherscan.md),
  [Routescan](reference/routescan.md), [Blockscout](reference/blockscout.md) and
  [Etherscan-compatible explorers](reference/etherscan-compatible.md).
- Concepts: [match types](explanation/match-types.md),
  [Etherscan plans and attribution](explanation/etherscan-plans-and-attribution.md) and the
  [glossary](explanation/glossary.md).
- [API reference](https://aelmanaa.github.io/explorer-verify/api/): every export of each package,
  on the docs site.

> [!NOTE]
> The APIs are experimental before 1.0.
