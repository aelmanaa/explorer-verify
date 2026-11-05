---
"explorer-verify": patch
---

The routing table now lists Routescan for the 38 chains whose Routescan API answered a keyless probe on 2026-11-05, and has 314 rows. 26 of these chains had no row and now have Routescan alone, among them Henesys (68414), Beam (4337), Chiliz (88888), Dexalot (432204) and DFK (53935). The other 12 keep their backends and add Routescan last, among them Ethereum (1), Sepolia (11155111), Avalanche C-Chain (43114) and Fuji (43113), Mantle (5000), Metis (1088) and Hemi (43111).

- `route: { backend: "routescan" }` now works without `route.apiUrl` on these chains, and a key in `apiKeys.routescan` is sent to `api.routescan.io` on that route.
- With no option, a call on a Routescan-only row, such as 68414, goes to Routescan. Before, it threw `unsupported-chain`.
- On the 12 chains that already had a row, a call goes where it went before: Routescan comes after Sourcify and Etherscan v2.
- `verifyEach()` with `backends: "all"` now also verifies on Routescan on these 38 chains, since Routescan needs no key. On Sepolia without a key, that is Sourcify and Routescan.
- A result from Routescan still has no `explorerUrl`.

[#168](https://github.com/aelmanaa/explorer-verify/issues/168)
