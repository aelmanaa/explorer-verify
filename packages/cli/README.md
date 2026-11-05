# @explorer-verify/cli

The `explorer-verify` command. It verifies the source of deployed smart contracts on Etherscan,
Blockscout, Sourcify and Routescan from a terminal, a CI job or an agent.

Status: before 0.1.0; nothing is published to npm yet. `explorer-verify verify` submits a contract
and `explorer-verify status` resumes a job from its handle. With `--json`, stdout holds one JSON
envelope, logs and progress go to stderr, and the exit codes are documented.
`explorer-verify --help` lists the commands, options, environment variables and exit codes, and
`explorer-verify --version --json` prints the versions and the routing table's date. See the
[CLI reference](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/cli.md)
and the [repository README](https://github.com/aelmanaa/explorer-verify#readme).
