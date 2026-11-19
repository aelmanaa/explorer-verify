---
"explorer-verify": minor
---

`buildVerifyInput` builds `kind: "vyper"` input from a bare Vyper Standard JSON, the output of `vyper -f solc_json` and a Foundry Vyper build-info. It keeps only `language`, `sources`, `interfaces` and `settings`, and drops `compiler_version`, `integrity` and each source's `sha256sum`. A Foundry build-info names `0.4.3` without a commit, and the PyPI builds print a 7-character commit such as `0.4.0+commit.e9db8d9`; a table of the stable releases from 0.3.10 completes both, and a release it does not list needs `compilerVersion`. A module from a Python environment, keyed after an index run or under the project's `.venv`, is moved to the path after its last `site-packages`, such as `snekmate/auth/ownable.vy`, with the search path `.`. Any other indexed, absolute or climbing path throws `invalid-input`, naming no path, and so does an input with `storage_layout_overrides`. A Hardhat 2 Vyper artifact on its own throws `insufficient-artifact` with the Vyper routes. No backend verifies Vyper yet.

`validateInput` now also refuses a Vyper path whose index run is spelled with `.`, empty or `name/..` segments, such as `./ ./0/1/x` or `src/../0/1/x`, and a Vyper input with `storage_layout_overrides`. The `details.candidates` of an `incomplete-input` error on `contract` no longer lists a name whose path is local.

What should I do? Nothing for Solidity input. Code that caught `unsupported-compiler` from `buildVerifyInput` for Vyper documents now gets a `kind: "vyper"` result, which `verify()` still refuses.

Issue: https://github.com/aelmanaa/explorer-verify/issues/425
