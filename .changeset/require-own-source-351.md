---
"@explorer-verify/cli": patch
"explorer-verify": patch
---

`explorer-verify verify` takes `--require-own-source`. When the explorer holds another contract's
source at the address, `verify` returns `already-verified` with `result.storedContract`, and the
run exits 0. With the flag, that run exits 1 instead, and the JSON envelope keeps the result with
`ok: false`. Without the flag, nothing changes.

```sh
explorer-verify verify 0x… --chain sepolia --foundry . --contract src/Greeter.sol:Greeter \
  --backend sourcify --require-own-source --json
```

With a repeated `--backend`, each outcome with another contract's source gets `ok: false` and
counts as exit code 1. `status` does not take the flag: a resumed handle never carries
`storedContract`.

`envelope.schema.json` accepts the two new forms: `ok: false` with an `already-verified` result
that has `storedContract`, at the top level and in an outcome. Its description now says that,
within `schemaVersion` 1, a release may add forms that only an opt-in CLI flag produces. A run
without the flag never prints them, so this is a patch. `toEnvelope()` and `exitCodeOf()` are
unchanged.

[#351](https://github.com/aelmanaa/explorer-verify/issues/351)
