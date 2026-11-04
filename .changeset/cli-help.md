---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

The CLI gains help and a version. `explorer-verify --help`, `-h`, `help` and `help <command>`
print examples first, then the usage, the options, the environment variables, the exit codes and
links to the docs and `llms.txt`, and exit 0. `explorer-verify --version` prints the CLI and core
versions; with `--json` it also prints `routingTableDate`, the date of the routing table. With
`--json`, help and the version print one envelope, and the package ships their JSON Schemas as
`@explorer-verify/cli/help.schema.json` and `@explorer-verify/cli/version.schema.json`.

A mistyped command or option exits 2 with `invalid-input`, and the hint names the closest command
or option, such as `Did you mean --color?`. The usage hint now also points to `--help`.

The CLI reference is generated from the CLI's help, and `pnpm run check` fails when it is stale.

The core package exports `routingTableDate()`, which returns the date of its routing table.

[#103](https://github.com/aelmanaa/explorer-verify/issues/103)
