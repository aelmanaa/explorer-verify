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

| Note                                                             | Question                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [2026-11-02-agent-readiness.md](2026-11-02-agent-readiness.md)   | What makes docs and a CLI usable by a coding agent?                                                                             |
| [2026-11-02-cli-sdk-logging.md](2026-11-02-cli-sdk-logging.md)   | How should the CLI split its output streams, and how should the library log?                                                    |
| [2026-11-02-etherscan-terms.md](2026-11-02-etherscan-terms.md)   | What do Etherscan's API terms allow for keys, proxies and plans?                                                                |
| [2026-11-02-explorer-apis.md](2026-11-02-explorer-apis.md)       | How do Etherscan v2, Sourcify v2 and Blockscout verify, and can a browser call them?                                            |
| [2026-11-02-landscape.md](2026-11-02-landscape.md)               | What exists already, including thirdweb, and is there demand?                                                                   |
| [2026-11-02-sourcify-v2.md](2026-11-02-sourcify-v2.md)           | What does each Sourcify v2 answer mean, and how does the client map it?                                                         |
| [2026-11-03-m2-live-probes.md](2026-11-03-m2-live-probes.md)     | What do Etherscan, Routescan and Sourcify answer for omitted arguments, keyless submits, factory children and linked libraries? |
| [2026-11-03-routescan-zksync.md](2026-11-03-routescan-zksync.md) | What are Routescan's hosts, request format, key policy and CORS, and which compiler does zkSync Era use?                        |
