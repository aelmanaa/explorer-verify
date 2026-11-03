# User documentation

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../llms.txt) lists every page of these docs.

Audience: developers using explorer-verify. Nothing is released yet, so most of this section is
still to come.

| Page                                                                                           | What it covers                                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Using explorer-verify from an agent](guides/using-from-an-agent.md)                           | Safe steps and the permanent submit, API keys, the Etherscan plan rule |
| [Verify a contract shipped in an npm package](guides/verify-a-contract-from-an-npm-package.md) | Build the input from build-info or artifacts of unknown origin         |
| [Errors](reference/errors.md)                                                                  | Every error code, with its cause and fix                               |
| [JSON output and exit codes](reference/json-output.md)                                         | The JSON envelope, its schema and the exit code of every outcome       |
| [Sourcify](reference/sourcify.md)                                                              | What is sent to Sourcify, and how each answer becomes a result         |

Pages land with the features they describe, in four kinds (the Diátaxis layout used by [hardhat-kms](https://github.com/aelmanaa/hardhat-kms)):

| Folder         | Kind              | Planned first page                                                         |
| -------------- | ----------------- | -------------------------------------------------------------------------- |
| `tutorials/`   | Learning by doing | Deploy a contract from a dapp, then verify it                              |
| `guides/`      | Task how-tos      | Verify from a browser; run the server handler; verify from CI with the CLI |
| `reference/`   | Exact facts       | API reference generated from TSDoc; errors; supported chains and explorers |
| `explanation/` | Background        | Match types (exact, partial, similar); Etherscan plans and attribution     |

Each user page states the version it describes in a `Version:` line and links
[llms.txt](../../llms.txt) near the top. Once published, the npm package will ship these pages
under `docs/` with its own `llms.txt`, so an agent working in `node_modules` reads the docs of the
installed version.
