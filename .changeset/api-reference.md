---
"explorer-verify": patch
---

The docs site has an API reference at https://aelmanaa.github.io/explorer-verify/api/, generated from the TSDoc of `explorer-verify`, `explorer-verify/server`, `explorer-verify/resolve`, `@explorer-verify/foundry` and `@explorer-verify/hardhat`. It is not in the package; the `.d.ts` files carry the same comments. Every member of `VerifyResult`, `VerifyEvent`, `Envelope` and `SolidityStandardJsonInput.sources` now has TSDoc. `Envelope` now names its result forms with `Extract<VerifyResult, Record<"status", …>>`; the type is unchanged. Issue: https://github.com/aelmanaa/explorer-verify/issues/85
