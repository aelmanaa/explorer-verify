# @explorer-verify/cli

The `explorer-verify` command. It will verify the source of deployed smart contracts on Etherscan,
Blockscout, Sourcify and Routescan from a terminal, a CI job or an agent.

Status: in design; nothing is published to npm yet. The output contract is in place: one JSON
envelope on stdout with `--json`, logs and progress on stderr, and documented exit codes. The
`verify` and `status` commands come next. See the
[CLI reference](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/cli.md)
and the [repository README](https://github.com/aelmanaa/explorer-verify#readme).
