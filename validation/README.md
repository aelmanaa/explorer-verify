# Adoption validation

These five private consumer projects test the public SDK and CLI outside their package tests.
Each project has its own source, runner, fixtures and evidence. They consume packed packages.
The projects belong to this repository; they establish integration behavior, not upstream adoption.

Tracked by [issue #263](https://github.com/aelmanaa/explorer-verify/issues/263).

| Project                                      | Question                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Browser and Remix](browser-remix/README.md) | Can a browser plugin consume compiler and deployment data and verify through the SDK? |
| [CCIP](ccip/README.md)                       | Can a token and pool SDK expose verification through its own API and CLI?             |
| [Hardhat](hardhat/README.md)                 | Can a real Hardhat task delegate explorer work to the SDK?                            |
| [CLI comparison](cli-comparison/README.md)   | Which verification workflows do the standalone CLI and Forge complete?                |
| [Python, Go and Java](polyglot/README.md)    | Can other languages drive the CLI and parse its outcomes without a terminal?          |

[Recovering incomplete deployment information](recovery.md) describes the supported recovery path
and the information an LLM must obtain before submitting.

## Run

Install the repository dependencies first. Individual project READMEs list their additional
runtime requirements. The browser project needs Chromium or its documented installed-browser
option; the comparison uses Foundry; the language project needs Python, Go and a Java JDK.
Each project installs its pinned consumer dependencies in an isolated directory.

Run all five against the current checkout:

```sh
pnpm run validate:adoption
```

Run one project:

```sh
pnpm run validate:adoption --project ccip
```

Check another built source checkout, such as a release candidate:

```sh
pnpm run validate:adoption --package-dir /path/to/candidate
```

Use an existing directory containing the four package tarballs:

```sh
pnpm run validate:adoption --tarballs /path/to/tarballs --output /path/to/results
```

The runner builds and packs the selected checkout when `--tarballs` is absent. It checks that the
four package names and versions agree, then starts each selected consumer with stdin closed.
It preserves per-project stdout and stderr and writes `summary.json`. A failed or timed-out
project makes the suite fail. A missing runtime is a failure, not a successful skipped case.

## Evidence boundaries

Local explorer stand-ins exercise actual SDK requests and CLI processes against controlled
responses. Their success does not establish that a public explorer accepted those sources.
Each project records what it compiled, deployed, simulated or requested, and the limits of its
comparison. Local chains use disposable accounts and require no testnet funds.

The release checklist distinguishes these consumer runs from the recorded live explorer probes.
After 0.1.0, the Remix project can support an upstream integration proposal and plugin PR, followed
by tests on several public testnets with the maintainers. This suite makes no upstream changes.
