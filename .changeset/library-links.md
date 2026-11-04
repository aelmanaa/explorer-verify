---
"explorer-verify": patch
---

Add `libraries` to `VerifyInput`: library link addresses keyed by `path:Name`, for a contract that calls an external library. `validateInput` checks each key and address, rejects a local path or a path that is not a source, and rejects any other value that `settings.libraries` already holds for the same library under its path. Issues name `libraries.<position>`, never the key. `verify()` sends the compiler input unchanged, because adding the addresses changes the metadata hash of a contract linked after compiling, and in a live test on 2026-11-03 Sourcify then gave only a partial match. Add `linkLibraries`, which merges the addresses into `settings.libraries` for an explorer that needs them there. It also checks a value under the empty path, which solc applies to every file.

[#65](https://github.com/aelmanaa/explorer-verify/issues/65)
