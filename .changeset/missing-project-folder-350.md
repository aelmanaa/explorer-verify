---
"@explorer-verify/hardhat": patch
"@explorer-verify/foundry": patch
"@explorer-verify/cli": patch
---

A project folder that does not exist, is a file or cannot be read is now reported on `root`:
"The input is invalid: root is not a folder: it does not exist." The message never repeats the
path, since a path typed by mistake can hold a key. Both helpers use the same wording.

The Hardhat helper checks `root` first, before the artifacts folder, even when `outDir` or
`artifact` is an absolute path. It no longer reports a missing `outDir` that the caller did not
pass.

The Foundry helper's `invalid-input` messages now carry the issue text, as the Hardhat helper's
do: "The input is invalid: root is not a folder: …" instead of "The input is invalid: root." An
output directory that this process cannot read is now `outDir could not be read`, not
`outDir is not a directory`.

The CLI names `--foundry` or `--hardhat` in the message and the issue, and its hint says to check
the folder instead of to compile the project:

```text
$ explorer-verify verify 0x… --chain 11155111 --hardhat no/such/project --contract contracts/A.sol:A --dry-run
error: The input is invalid: --hardhat is not a folder: it does not exist. (invalid-input)
  hint: Check the folder that --hardhat names: it must exist and should hold the Hardhat config. Pass . for the current folder.
```

Without `--out-dir`, a project folder with no output folder, or one the CLI cannot read, now
names the project flag in the message too, for both Foundry and Hardhat: "The input is invalid:
--hardhat has no artifacts folder: build the project, or pass --out-dir." The message used to
name `--out-dir`, which the caller had not passed. The hint is unchanged.

[#350](https://github.com/aelmanaa/explorer-verify/issues/350)
