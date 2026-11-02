<!-- Every pull request links its issue with a closing keyword (`Closes #n`). Open the issue first if none exists. -->

Closes #

## What changes

## Requirements

<!-- R-… IDs this change implements or changes. "None" if none. -->

## How it was tested

<!-- Unit tests, and for a backend change the live run against the explorer (date, chain, result). -->

## Docs

<!-- Which user or contributor pages changed? New pages are linked from AGENTS.md and docs/README.md. Write "None" if nothing user- or contributor-visible changed. -->

## Agent readiness checklist

<!-- Applies when the change adds or changes a public function, error, CLI command or user page (R-AX, decision 0007). Keep the items that apply, tick them, and delete the rest. Name any R-AX requirement the change does not meet, and why, under "Requirements". -->

- [ ] **Errors.** Each new or changed error has a stable code, a hint that names the fix and a docs entry (R-AX-10).
- [ ] **Docs.** Each new or changed user page is listed in `llms.txt`, links `llms.txt` near the top and states the version it describes (R-AX-1 to R-AX-3).
- [ ] **Skill.** The shipped skill and its examples cover the changed user-visible behaviour (R-AX-4).
- [ ] **JSON.** `--json` prints the versioned envelope; a schema change only adds fields (R-AX-5).
- [ ] **Streams.** stdout carries only the result, nothing prompts, and piped output has no colour (R-AX-6).
- [ ] **Exit codes.** Each new outcome or error code maps to a documented exit code (R-AX-7).
- [ ] **Dry run.** `--dry-run` covers the new path, stops before the submit and needs no key (R-AX-8).
- [ ] **Key input.** The CLI reads keys from the environment or `--api-key-file`, never from a flag value (R-AX-9).
- [ ] **Help.** `--help` shows an example for the new command or flag; a typo suggests the closest match (R-AX-10, R-AX-11).
- [ ] **Determinism.** The same input gives the same output: stable key order, no timestamps unless requested (R-AX-12).

## Security checklist

<!-- Keep the items that apply to this change, tick them, and delete the rest. -->

- [ ] **Keys.** No API key reaches a log, an error message, a result object or a test fixture.
- [ ] **Server handler.** The handler still forwards only the verify and status actions, and its allowlists and limits still apply.
- [ ] **Network.** Every request goes through the injected `fetch`; nothing calls a host the caller did not configure or the routing table does not list.
- [ ] **Results.** An unknown or ambiguous explorer answer is reported as an error, never as verified.
- [ ] **Changeset.** A changeset is added, or nothing under `packages/` changed for users.
- [ ] **Supply chain.** A new dependency, lifecycle script or `bin` entry is named in the description.
