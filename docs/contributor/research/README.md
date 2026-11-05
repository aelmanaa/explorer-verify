# Research

Audience: contributors who need the evidence behind a requirement or decision. One note per
research date, named `YYYY-MM-DD-topic.md`. A note is corrected only with a dated entry under a
`## Corrections` heading at its end, which says what changed. New findings go in a new dated note
that links the old one.

Each note has a `## Sources` section with at least one http or https URL, as a Markdown link or a
bare URL outside code. Each factual claim in the note names its source: a URL and the date it was
read, or, for something observed by running a tool, the tool, its version and the date. A claim without a source is removed or marked as an open
question. Each note is listed in the table below.

`pnpm run check` fails when a note has no `## Sources` section, when that section has no http or
https URL, or when the note is missing from this table. Whether each claim has a source is checked
in review.

| Note                                                                                   | Question                                                                                                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [2026-11-02-agent-readiness.md](2026-11-02-agent-readiness.md)                         | What makes docs and a CLI usable by a coding agent?                                                                                                 |
| [2026-11-02-cli-sdk-logging.md](2026-11-02-cli-sdk-logging.md)                         | How should the CLI split its output streams, and how should the library log?                                                                        |
| [2026-11-02-etherscan-terms.md](2026-11-02-etherscan-terms.md)                         | What do Etherscan's API terms allow for keys, proxies and plans?                                                                                    |
| [2026-11-02-explorer-apis.md](2026-11-02-explorer-apis.md)                             | How do Etherscan v2, Sourcify v2 and Blockscout verify, and can a browser call them?                                                                |
| [2026-11-02-landscape.md](2026-11-02-landscape.md)                                     | What exists already, including thirdweb, and is there demand?                                                                                       |
| [2026-11-02-sourcify-v2.md](2026-11-02-sourcify-v2.md)                                 | What does each Sourcify v2 answer mean, and how does the client map it?                                                                             |
| [2026-11-03-m2-live-probes.md](2026-11-03-m2-live-probes.md)                           | What do Etherscan, Routescan and Sourcify answer for omitted arguments, keyless submits, factory children and linked libraries?                     |
| [2026-11-03-routescan-zksync.md](2026-11-03-routescan-zksync.md)                       | What are Routescan's hosts, request format, key policy and CORS, and which compiler does zkSync Era use?                                            |
| [2026-11-03-api-key-placement.md](2026-11-03-api-key-placement.md)                     | Where do Etherscan v2 and Routescan take an API key, and what do they answer for a missing, refused or spent one?                                   |
| [2026-11-03-hardhat-build-layout.md](2026-11-03-hardhat-build-layout.md)               | Where do Hardhat 2 and Hardhat 3 write a contract's artifact and build-info, and how does one name the other?                                       |
| [2026-11-03-docs-site-and-versioning.md](2026-11-03-docs-site-and-versioning.md)       | Where should the public docs live, built with which generator, and how should they and `docsUrl` be versioned?                                      |
| [2026-11-03-versioning-0x-or-1-0.md](2026-11-03-versioning-0x-or-1-0.md)               | Should the first release be 0.1.0 or 1.0.0, and what do npm ranges and changesets do with 0.x?                                                      |
| [2026-11-03-routing-table.md](2026-11-03-routing-table.md)                             | Which chains does the routing table list, from which public lists, and what changed against the prior art?                                          |
| [2026-11-04-etherscan-client.md](2026-11-04-etherscan-client.md)                       | Which Etherscan v2 `result` texts does the client map, where was each seen, and how is Similar Match read?                                          |
| [2026-11-04-routescan-client.md](2026-11-04-routescan-client.md)                       | How does Routescan answer each client request, which networks do its chains use, and how does the client map each answer?                           |
| [2026-11-04-bytecode-metadata-sources.md](2026-11-04-bytecode-metadata-sources.md)     | Where can the metadata behind a bytecode's hash be fetched, and how is it checked against the hash?                                                 |
| [2026-11-04-etherscan-rows.md](2026-11-04-etherscan-rows.md)                           | Which chains get an Etherscan v2 entry and in which order, checked on 2026-11-04, and what does it add in size?                                     |
| [2026-11-04-blockscout-client.md](2026-11-04-blockscout-client.md)                     | Which Blockscout API does the single-chain client use, which answers does it map, and where was each seen?                                          |
| [2026-11-04-lazy-client-chunks.md](2026-11-04-lazy-client-chunks.md)                   | Do the main bundlers put a client loaded with `import()` in its own chunk, and what does each client weigh on its own?                              |
| [2026-11-04-etherscan-compatible-client.md](2026-11-04-etherscan-compatible-client.md) | Does any prior-art standalone host answer, what does a retired Etherscan host answer, and how does the standalone client differ?                    |
| [2026-11-04-proxy-linking.md](2026-11-04-proxy-linking.md)                             | What do Etherscan, Blockscout and Sourcify answer when asked to link a proxy, seen live on a Sepolia ERC-1967 proxy, and how is each answer mapped? |
| [2026-11-05-fetch-redirect-signals.md](2026-11-05-fetch-redirect-signals.md)           | Which fields of a `fetch` answer show a redirect, and what does `Response.url` hold when a `fetch` sends to a server handler?                       |
| [2026-11-05-dapp-tutorial-sepolia-run.md](2026-11-05-dapp-tutorial-sepolia-run.md)     | Does the dapp tutorial's code reach a verified contract on Sepolia?                                                                                 |
| [2026-11-03-mutation-testing.md](2026-11-03-mutation-testing.md)                       | Which tool can mutate the TypeScript sources and judge each mutant with the `node --test` unit tests, with no build step?                           |
