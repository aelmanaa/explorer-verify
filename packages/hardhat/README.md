# @explorer-verify/hardhat

Finds a contract's build files in a Hardhat 2 or Hardhat 3 project and passes them to
`buildVerifyInput` from [`explorer-verify`](https://github.com/aelmanaa/explorer-verify). It runs on
Node 22.18 and later. It reads files only: it does not compile, and it needs no `hardhat` package.
Install `explorer-verify` next to it: the core is a peer dependency.

Status: before 0.1.0; nothing is published to npm yet. See the
[guide](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/guides/verify-from-a-hardhat-project.md).
