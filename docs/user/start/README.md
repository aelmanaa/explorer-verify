# Quickstarts

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: anyone who wants a first dry run before reading a guide.

You need: Node.js 22.18 or later. No API key, wallet or deploy.

Each quickstart fits on about one screen. It dry runs the
[sample request](greeter-sepolia.json), a Greeter that Sourcify already verified on Sepolia, then
shows the real run.

## Pick your setup

- [Browser dapp](quickstart-browser.md): a Vite page runs `dryRun()` with no key and no server.
- [Node.js script](quickstart-node.md): a TypeScript script runs `dryRun()`, then `verify()`.
- [The CLI](quickstart-cli.md): one `npx` command dry runs the sample, then your own contract.
- [Foundry project](quickstart-foundry.md): the CLI reads `out/` with `--foundry .`.
- [Hardhat project](quickstart-hardhat.md): the CLI reads a Hardhat 2 or 3 build; not a plugin.
- [SDK wrapper](quickstart-sdk-wrapper.md): one explorer client, with its errors mapped onto
  yours.
- [AI agent](quickstart-agent.md): a prompt that dry runs, asks you, then verifies.

## Next steps

- [Which package to install](which-package.md): the four packages and when to use each.
- [Overview](../README.md): every page of the docs, grouped by kind.
- [Glossary](../explanation/glossary.md): backend, route, handle, lookup and other terms.
