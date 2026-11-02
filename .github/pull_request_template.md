<!-- Every pull request links its issue with a closing keyword (`Closes #n`). Open the issue first if none exists. -->

Closes #

## What changes

## Requirements

<!-- R-… IDs this change implements or changes. "None" if none. -->

## How it was tested

<!-- Unit tests, and for a backend change the live run against the explorer (date, chain, result). -->

## Docs

<!-- Which user or contributor pages changed? New pages are linked from AGENTS.md and docs/README.md. Write "None" if nothing user- or contributor-visible changed. -->

## Security checklist

<!-- Keep the items that apply to this change, tick them, and delete the rest. -->

- [ ] **Keys.** No API key reaches a log, an error message, a result object or a test fixture.
- [ ] **Server handler.** The handler still forwards only the verify and status actions, and its allowlists and limits still apply.
- [ ] **Network.** Every request goes through the injected `fetch`; nothing calls a host the caller did not configure or the routing table does not list.
- [ ] **Results.** An unknown or ambiguous explorer answer is reported as an error, never as verified.
- [ ] **Changeset.** A changeset is added, or nothing under `packages/` changed for users.
- [ ] **Supply chain.** A new dependency, lifecycle script or `bin` entry is named in the description.
