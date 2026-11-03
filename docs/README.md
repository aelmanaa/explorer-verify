# explorer-verify docs

Audience: everyone. This is the index for people; agents start at [AGENTS.md](../AGENTS.md).

## Users

User documentation is written as features land: [user/README.md](user/README.md). Agents start
with [Using explorer-verify from an agent](user/guides/using-from-an-agent.md) and the
[llms.txt](../llms.txt) index.

| Page                                                                                                | What it covers                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Verify a contract shipped in an npm package](user/guides/verify-a-contract-from-an-npm-package.md) | Build the input from build-info, artifacts or metadata of unknown origin |
| [verify()](user/reference/verify.md)                                                                | The steps, options, results and errors of `verify()`                     |
| [checkStatus()](user/reference/check-status.md)                                                     | Resume a submitted verification from its handle                          |
| [Errors](user/reference/errors/index.md)                                                            | Every error code, with its cause and fix                                 |
| [JSON output and exit codes](user/reference/json-output.md)                                         | The JSON envelope, its schema and the exit code of every outcome         |
| [Sourcify](user/reference/sourcify.md)                                                              | What is sent to Sourcify, and how each answer becomes a result           |
| [Logging and events](user/reference/logging-and-events.md)                                          | The logger, the stage events, their schema and key redaction             |
| [Agent skill](../skills/explorer-verify/SKILL.md)                                                   | The skill shipped in the package, with examples tested against the build |

## Contributors

| Page                                         | What it covers                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Requirements](contributor/requirements.md)  | What the library must do, with IDs                                                                                       |
| [Architecture](contributor/architecture.md)  | Packages, modules, flow, extension points                                                                                |
| [Roadmap](contributor/roadmap.md)            | Milestones and the first issues                                                                                          |
| [Adoption](contributor/adoption.md)          | Adoption goal, kinds of users, what each needs, and when                                                                 |
| [Decisions](contributor/decisions/README.md) | Numbered decision records                                                                                                |
| [Prior art](contributor/prior-art.md)        | The two implementations to port from                                                                                     |
| [Research](contributor/research/README.md)   | Dated evidence: explorer APIs, Etherscan terms, landscape, agent readiness, CLI output and logging, live explorer probes |
| [Testing](contributor/testing.md)            | Test layers and rules                                                                                                    |
| [Tooling](contributor/tooling.md)            | Toolchain and type-checking layout                                                                                       |
| [Releasing](contributor/releasing.md)        | Release plan and first publish                                                                                           |
| [Contributing](../CONTRIBUTING.md)           | Issues, labels, workflow, changesets                                                                                     |
| [Security](../SECURITY.md)                   | Reporting vulnerabilities                                                                                                |
