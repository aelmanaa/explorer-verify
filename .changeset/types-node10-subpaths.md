---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

TypeScript projects that set `"moduleResolution": "node"` now find the types of every subpath, such as `explorer-verify/core` and `explorer-verify/clients/sourcify`, and of the JSON schema files. Before, these imports failed with TS2307. `bundler`, `node16` and `nodenext` resolve the same files as before. [#295](https://github.com/aelmanaa/explorer-verify/issues/295)
