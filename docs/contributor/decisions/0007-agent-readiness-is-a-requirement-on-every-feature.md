# 0007: Agent readiness is a requirement on every feature

Status: Accepted (2026-11-02)

## Context

Coding agents will call explorer-verify as often as people: an agent adds it to a dapp, runs the CLI
in CI or reads the docs to answer a question. Before this decision, the requirements asked only for
"JSON output for scripts" (R-DX-1) and typed errors with a fix hint (R-DX-3). Nothing fixed exit
codes, the JSON shape, prompts, dry runs, output streams, version-matched docs or guidance shipped
with the package, although each of these decides whether an agent can use the CLI unattended.

Verification has one irreversible step: a submit publishes the source on a public explorer. An agent
has to be able to check everything up to that step without side effects. It also has to tell a
definitive rejection, a transient failure and an answer the library cannot classify apart without
parsing text: it retries the second, and a person checks the third (exit codes 1, 5 and 6 in
R-AX-7).

The CLI and the user docs do not exist yet. Setting the contract now costs little; changing it after
0.1.0 breaks every script and agent that relies on it. The evidence is in
[research/2026-11-02-agent-readiness.md](../research/2026-11-02-agent-readiness.md). Most of it is
practitioner guidance plus one controlled docs benchmark; no peer-reviewed study isolates CLI design
properties against agent success. The checks are testable, so they become requirements.

## Decision

- Agent readiness (R-AX in [requirements.md](../requirements.md#agent-readiness-r-ax)) applies to
  every pull request that adds or changes a public function, error, CLI command or user page. The
  pull request meets each requirement that applies, or names the one it does not meet and why.
  CONTRIBUTING.md lists it in the definition of done and the pull request template carries a
  checklist.
- The CLI prints human output on a terminal and a stable, versioned JSON envelope with `--json`
  (R-AX-5). It does not print JSON by default. Reason: people run the CLI by hand after a deploy,
  and gh, Terraform and clig.dev follow the same pattern. Cloudflare's `cf` defaults to JSON; its
  docs address agents and scripts first. Agents learn to pass `--json` from `--help`, the shipped skill and the agent page.
- Agent guidance ships as the CLI plus a skill inside the npm package (R-AX-4), not as an MCP server
  for now. Revisit after the agent evaluation (R-AX-13).
- The npm package ships `docs/user/` as `docs/`, plus an `llms.txt` whose links are relative to the
  packaged docs (R-AX-2). An agent working in `node_modules` reads the docs of the installed
  version. The repository-root `llms.txt` (R-AX-1) links the Markdown on GitHub until a docs site
  exists.

## Alternatives considered

- Agent support as a separate feature, added at the end of M4. Rejected: every function, error and
  command added before then would need a second pass, and the contract would be set after scripts
  already depend on the output.
- JSON by default, with a `--human` flag. Rejected for the reason above: it makes the common manual
  run worse and gains little, since an agent only has to add one flag.
- An MCP server alongside or instead of the CLI. Deferred. One published comparison of an MCP server
  and a CLI for the same tasks found no clear difference in success, and found that tool design and
  docs mattered more than the protocol. A server is a second interface to keep in step with the
  library. The R-AX-13 evaluation gives data to decide on.
- Docs on a website only. Rejected for now: a website shows the latest version, which can differ
  from the installed one. Versioned docs in the package need no hosting.
- A skill in a separate repository. Rejected: a separate repository needs its own release step to
  stay in step with the package, while a skill in the package is tested against the same build
  (R-AX-4).

## Consequences

- Each pull request in scope does more work: an error needs a code, a hint and a docs entry, a page
  needs an `llms.txt` entry and a version line, a CLI command needs `--json`, an exit code and a
  dry-run path.
- CI enforces what it can. The docs check (#4), the contract tests (#5), the skill example tests
  (#6) and the CLI harness (#7) fail a pull request that misses a requirement; review covers the
  rest until then.
- The JSON envelope and the exit codes are public API. Changing their meaning needs a new schema
  version and a major release.
- The package grows by the size of `docs/` and the skill.
- The MCP question stays open until the R-AX-13 results exist.
