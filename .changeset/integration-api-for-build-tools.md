---
"explorer-verify": minor
---

`route.explorerUrl` sets the explorer's page base for a route. The result's `explorerUrl` is built from it, so a route given by `route.apiUrl` now has a contract page link. It is checked as `route.apiUrl` is, and must not hold a query string.

Breaking: a `failed` result now carries `reasonCode`: `bytecode-mismatch`, `missing-source`, `compiler`, `contract-name`, `constructor-args`, `libraries` or `unknown`. Each client reads it from the explorer's answer, and `reason` keeps the explorer's text. A tool that sends a reduced compiler input first can retry with the full input on `missing-source`. Code that builds a `failed` result, such as a test double, adds the field.

Breaking for an exhaustive `switch` on events: `verify()` emits a `verify.stored` event, with `backend`, `name` and `compilerVersion`, when the lookup finds another contract's source, before it submits. An exhaustive `switch` on the event type adds the new case. The CLI prints it at the debug level.

Messages, log lines and hints name the explorer by its label, such as `Etherscan` or `Sourcify`, instead of the backend id. `details.backend` and the `backend` log field keep the id. `BACKEND_LABELS`, from `explorer-verify/backends` and `explorer-verify`, maps each backend to its label.
