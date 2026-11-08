# Adoption validation, 2026-11-08

Audience: contributors reviewing [issue #263](https://github.com/aelmanaa/explorer-verify/issues/263)
and the consumer validation before 0.1.0.

Question: can independent browser, SDK, framework and non-TypeScript consumers use the packed
SDK and CLI, and which limitations remain?

Five independent project sessions built the consumers in separate worktrees. Their integrated
runs passed 72 scenarios against the four 0.1.0 candidate tarballs from commit
`df036c7245c1baefa869478c7a5a00ca5366d8a2`. The same five runners also passed against packages
freshly built and packed from the current source checkout, which still declares 0.0.0.
The package source files are identical between the tested candidate and the base main commit
`179c0a74c87380c64648db6c5c66859eef868906`.

The [suite index](../../../validation/README.md) gives reproducible commands.
[Combined results](../../../validation/results.json) identify the runs. Each project retains
its own evidence, tool pins and source attribution. The CI workflow repeats each consumer in its
own job and preserves logs and results. Scenario success means the expected outcome and assertions held, including expected
rejections and missing-input errors.

## Observed results

Observed on 2026-11-08 with Node.js 24.21.0. The project evidence records the additional tool
versions and the supplied package checksums.

| Consumer                 | Passed scenarios | Evidence                                                            | What ran                                                                                                                          |
| ------------------------ | ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Browser/Remix            | 16               | [Results](../../../validation/browser-remix/evidence/results.json)  | Real Chromium execution, solc 0.8.24 compilation, packed SDK bundle and Remix webview transport with a local host fixture         |
| CCIP SDK and CLI         | 6                | [Results](../../../validation/ccip/evidence/results.json)           | Authentic pinned token/pool inputs, ABI constructor encoding, shared SDK function and consumer CLI processes                      |
| Hardhat                  | 10               | [Results](../../../validation/hardhat/results/results.json)         | Real Hardhat 3.21.2 compilation under two profiles, strict TypeScript check and SDK-backed task                                   |
| Standalone CLI and Forge | 19               | [Results](../../../validation/cli-comparison/evidence/results.json) | Real Forge/Cast/Anvil 1.8.1, solc-js compilation, both verification CLIs, controlled explorer responses and SDK metadata recovery |
| Python, Go and Java      | 21               | [Results](../../../validation/polyglot/evidence/results.json)       | Actual language runtimes spawning the installed CLI and parsing its JSON and exit codes themselves                                |

The language project additionally ran three negative controls: each client rejected a deliberately
wrong expected result. These controls are separate from the 72 scenario total.

The browser's host and deployment receipt are local fixtures. Its initial evidence proves the
plugin protocol and browser SDK path; it does not show a deployed upstream Remix integration.
Its source recovery scenarios verify hashes and identical recompilation.

### Actual Remix IDE compilation

A separate network-dependent follow-up used Chrome 156.0.8078.80 and the actual Remix IDE
2.6.13 website. It loaded our external plugin through the real host, called
`solidity.compileWithParameters` with Counter and solc `0.8.24+commit.e11b9ed9`, and rebuilt the
returned compiler input through the public packed SDK. Three additional assertions passed,
separate from the 72 deterministic scenarios.

The [real-host evidence](../../../validation/browser-remix/evidence-real-remix/README.md) retains
the actual compilation response, metadata and rebuilt inputs. The build-info envelope wraps the
real method response's input/output/version locally. No compilation event was observed for this
method call. The run used a fresh browser context, disabled optional performance analytics and
granted local-network permission only to the Remix origins so they could load the loopback
plugin. Earlier UI-selector, overlay and local-network blockers remain separate recorded attempts.
No wallet was connected, and no deployment or explorer submission occurred. This proves the
compiled-data path through the real host, rather than full verification-plugin parity.

The CCIP project uses exact artifacts at upstream revision
`1cecb266d924bb52c6c6030e0bdc2b4b6f5e430e`, with recorded hashes and preserved license notices.
It validates constructor payloads, a mixed success/rejection batch, and pending handles resumed
without another submission. It does not modify the upstream CCIP SDK or recompile those artifacts.

The Hardhat project runs a real task with real generated build-info. It validates both build
profiles, rejection, resume, missing output and restoration. It does not establish full parity
with the upstream verification plugin, its configuration options or Ignition integrations.

## CLI comparison and recovery

Foundry verification is compared through Forge. Cast's broader RPC and wallet commands are
outside this verification comparison. Both verification CLIs complete the recorded success and
rejection cases against the controlled local explorer endpoint. Their recorded command traces
show the submission, pending and resume paths, missing-input outcomes and output formats.
This is a bounded functional comparison, with no general performance or developer-experience
superiority claim.

The comparison installs compiled runtime code with `anvil_setCode` on a local chain with zero
accounts. No deployment transaction occurs. The resolver recovers input from metadata through
its configured local gateway; recompiling that input reproduces the installed runtime. The
negative metadata-availability case remains an error. The CLI's address-only attempt remains an
input error, because it has no recovery command that wraps the SDK resolver.

The [recovery guide](../../../validation/recovery.md) records a staged workflow for an assistant:
collect known deployment facts, try published metadata, obtain missing source/build data, preserve
unknown settings, validate and locally compare uncertain builds before an authorized submission.
A dry run validates input and performs an explorer lookup; it does not compile or prove a
bytecode match. An LLM must not invent missing source code or compiler settings and present them
as recovered deployment facts.

## Limits and follow-up

All explorer verdicts in these new consumers come from controlled local responses or a local
fetch preload. No public explorer accepted a new submission during these runs. These projects
complement the existing dated live explorer probes; they do not replace them.

The examples belong to this repository and establish consumer interoperability. They do not
establish adoption by Remix, CCIP or Hardhat. Their version pins and platform results are in each
README. The five-run CI matrix covers Linux; the original recorded local runs used macOS and an
installed Chrome browser where applicable.

After the validated release, the browser project can support an upstream Remix issue and an
SDK-backed verification plugin PR. That work needs a complete verification-plugin integration and public-testnet
coverage with the maintainers. No upstream outreach or pull request occurred in this validation.

## Sources

- [Issue #263](https://github.com/aelmanaa/explorer-verify/issues/263) and its five sub-issues,
  read and implemented 2026-11-08: requested independent validation scope.
- Observed 2026-11-08 using the tool versions and package checksums in the five linked reports:
  the scenario outcomes, command traces, input recovery, HTTP payloads and process results.
- [Pinned CCIP source](https://github.com/smartcontractkit/ccip-tools-ts/tree/1cecb266d924bb52c6c6030e0bdc2b4b6f5e430e),
  read from the local git objects 2026-11-08: exact token/pool inputs, ABI and bytecode. The
  project's provenance file lists each original path and SHA-256.
- [Remix compilation artifacts](https://remix-ide.readthedocs.io/en/latest/contract_metadata.html),
  read 2026-11-08: compiler input/output and metadata artifact roles.
- [Hardhat verification](https://hardhat.org/docs/guides/smart-contract-verification), read
  2026-11-08: framework build profiles, explorer integration and the upstream parity boundary.
- [Forge](https://www.getfoundry.sh/forge/index.html) and
  [Cast](https://www.getfoundry.sh/cast/index.html), read 2026-11-08: verification commands and
  the distinction from broader RPC utilities.
