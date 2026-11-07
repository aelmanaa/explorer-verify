# 0058: Settle event and envelope fields before schema v1

Status: Accepted (2026-11-07). Extends decisions 0010 and 0055.

Research: [Event and envelope fields before schema v1](../research/2026-11-07-event-envelope-fields.md).

## Context

Issue #224 identifies inconsistent lookup names, concurrent events without an entry index, and
proxy results outside the envelope. No version of the package has shipped yet, so these field
changes can settle schema v1 before its compatibility promise starts at 0.1.0.

## Decision

- Use `lookup` for the four lookup states in both dry-run results and events. Keep `match` for
  exact and partial verification results.
- Give every `verifyEach()` event an `entry` index into `backends`, including one validation
  event per entry. Keep stage order within each entry; entries run concurrently.
- Include `explorerUrl` in successful verification result events when known.
- Give proxy linking its own `proxy.routed`, `proxy.poll`, `proxy.retry` and `proxy.result` events.
  A proxy result event holds the fields of the returned result.
- Accept `LinkProxyResult` in the envelope and exit-code helper. `linked` is a successful result
  with exit 0; `mismatch` and `not-linked` are results with exit 1. Keep failed verification
  results in `result`, with `ok: false`; reserve `error` for thrown errors.
- Make `Envelope<Result>` generic, distinguish successful multi-backend envelopes in its type,
  and make `BackendOutcome.result` and `.error` mutually exclusive. The schema also checks that
  the outer `ok` agrees with the multi-backend outcomes.
- Mark the proxy error codes as SDK only in CLI help. This change adds no proxy CLI command.

## Consequences

Exhaustive event switches add the proxy event names. Consumers read `lookup` on lookup events and
use `entry` when grouping a multi-backend call. Property-value checks distinguish result and error
members even when an optional opposite member exists in the type. The schema version stays 1;
after the first release, removing or changing these fields requires a schema-version change.
