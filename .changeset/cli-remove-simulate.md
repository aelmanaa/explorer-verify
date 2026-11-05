---
"@explorer-verify/cli": patch
---

The CLI no longer has the hidden `simulate` command. `explorer-verify simulate` now exits 2 as an
unknown command. The CLI's commands are `verify` and `status`, and the CLI reference no longer has
a hidden commands section.

[#137](https://github.com/aelmanaa/explorer-verify/issues/137)
