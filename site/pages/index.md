---
layout: home
title: Verify contract source on block explorers
description: Verify deployed contract source on Etherscan, Blockscout, Sourcify and Routescan from a browser, a backend, a CI job or an agent.

hero:
  name: explorer<span class="ev-title-accent">-verify</span>
  text: Verify contract source on block explorers
  image:
    src: /logo.svg
    alt: ""
  tagline: Etherscan, Blockscout, Sourcify and Routescan, from a browser, a backend, a CI job or an agent. Start with a dry run that needs no key.
  actions:
    - theme: brand
      text: Quickstart
      link: /start/
    - theme: alt
      text: Which package
      link: /start/which-package

features:
  - title: Browser dapp
    details: A Vite page runs dryRun() on the sample request. No key and no server.
    link: /start/quickstart-browser
    linkText: Browser quickstart
  - title: Node.js script or backend
    details: A TypeScript script runs dryRun(), then verify(), with Node.js alone.
    link: /start/quickstart-node
    linkText: Node.js quickstart
  - title: CLI and CI
    details: One npx command dry runs the sample request, then verifies from a CI job.
    link: /start/quickstart-cli
    linkText: CLI quickstart
  - title: Foundry project
    details: The CLI reads the build files under out/. The project gains no dependency.
    link: /start/quickstart-foundry
    linkText: Foundry quickstart
  - title: Hardhat project
    details: The CLI reads a Hardhat 2 or 3 build. Not a plugin, no config change.
    link: /start/quickstart-hardhat
    linkText: Hardhat quickstart
  - title: SDK or tool wrapper
    details: Call one explorer client from your SDK and map its errors onto yours.
    link: /start/quickstart-sdk-wrapper
    linkText: SDK wrapper quickstart
  - title: AI agent
    details: A prompt for a coding agent. It dry runs, asks you, then verifies.
    link: /start/quickstart-agent
    linkText: Agent quickstart
---

## Try it with no key

The sample request names a Greeter that Sourcify already verified on Sepolia.
A dry run looks it up and submits nothing:

```sh
repo=https://raw.githubusercontent.com/aelmanaa/explorer-verify/main
curl -fsSLO "$repo/docs/user/start/greeter-sepolia.json"
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

`lookup` is `exact`: the explorer already holds the contract, so a real run
would submit nothing. The [CLI quickstart](/start/quickstart-cli) goes on to
your own contract.

## The four packages

| Package                    | What it does                                       | Use it when                              |
| -------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `explorer-verify`          | Verify, dry run, resume and link a proxy from code | Your code calls the explorers            |
| `@explorer-verify/cli`     | The `explorer-verify` command, with JSON output    | A terminal, a CI job or an agent runs it |
| `@explorer-verify/foundry` | Builds the input from a Foundry project's `out/`   | Node.js code works in a Foundry project  |
| `@explorer-verify/hardhat` | Builds the input from a Hardhat 2 or 3 project     | Node.js code works in a Hardhat project  |

[Which package to install](/start/which-package) gives the install command and
the entry for each task.

## Find your way

- [Overview](/overview): every page of the docs, grouped as in the sidebar.
- [Guides](/guides/verify-from-node): one task per page, by setup or by task.
- [Reference](/reference/verify): `verify()`, the CLI, the JSON output and
  every error code.
- [API reference](/api/): every export of each package.
- [Glossary](/explanation/glossary): backend, route, handle and other terms.
- [llms.txt](https://aelmanaa.github.io/explorer-verify/llms.txt): the index for agents.
