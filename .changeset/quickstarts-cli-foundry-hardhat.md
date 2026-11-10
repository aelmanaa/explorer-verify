---
"explorer-verify": patch
---

The package ships three quickstarts under `docs/start/`: the CLI, a Foundry project and a
Hardhat project. Each one dry runs the sample request with `npx @explorer-verify/cli`, then the
reader's own project, then verifies, in at most five steps. The Hardhat quickstart says the CLI
is not a Hardhat plugin.
