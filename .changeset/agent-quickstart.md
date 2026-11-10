---
"explorer-verify": patch
---

The package ships `docs/start/quickstart-agent.md`, a quickstart for people who let a coding agent verify a contract. It holds a prompt to paste into the agent: a dry run of the docs' sample, a dry run of the contract, then a stop until the person approves the submit. The packaged `llms.txt` now opens with an Instructions section that lists the pages an agent reads first.
