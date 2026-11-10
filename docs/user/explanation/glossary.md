# Glossary

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: anyone who meets a term in these docs before its definition.

Each term has one short definition and a link to the page that covers it in full. The terms are in
alphabetical order.

## Backend

A backend is one explorer API that explorer-verify can submit to, such as `sourcify`,
`etherscan-v2` or `blockscout`. `BACKEND_NAMES` lists all six. The result's `backend` names the one
a call used. See [Routing](../reference/routing.md#how-a-chain-resolves).

## Client

A client is the code that talks to one backend. The main entry loads clients when a call needs
them; the core entry takes them from your options. See [Core entry](../reference/core.md#clients).

## Dry run

A dry run validates the input, resolves the route and looks the contract up once, then stops. It
never submits. Call `dryRun()`, or pass `--dry-run` to the CLI. See
[verify(): dry run](../reference/verify.md#dry-run) and [CLI: dry run](../reference/cli.md#dry-run).

## Envelope

The envelope is the one JSON object the CLI prints on stdout with `--json`. It holds
`schemaVersion`, `ok`, and either a `result` or an `error`. See
[JSON output and exit codes](../reference/json-output.md#the-envelope).

## Exact match

An exact match means the recompiled bytecode equals the deployed bytecode, metadata hash included.
See [Match types](../explanation/match-types.md#exact-and-partial).

## Handle

A handle names a submitted verification: its backend, chain, address and job id. Its one-line form
is `ev1:<backend>:<chainId>:<address>:<jobId>`. Store it, then pass it to `checkStatus()` to
resume. See [checkStatus(): the handle](../reference/check-status.md#the-handle).

## Job

A job is the explorer's work on one submission. The explorer gives it an id, and explorer-verify
polls that id until the job ends. The handle carries the job id. See
[verify(): what it does](../reference/verify.md#what-it-does).

## Lookup

A lookup asks the explorer whether it already holds the contract's source. `verify()` looks up
before it submits, and returns `already-verified` when it finds a match. A dry run reports what the
lookup found in its `lookup` field. See [verify(): what it does](../reference/verify.md#what-it-does).

## Match grade

The match grade is how closely an explorer says the source matches the deployed code: `exact` or
`partial`. A result carries it as `match`. See [Match types](../explanation/match-types.md).

## Partial match

A partial match means everything matches except the metadata hash. The sources compile to the
deployed code, but they may not be the exact files the deployer compiled. See
[Match types](../explanation/match-types.md#exact-and-partial).

## Route

The route is what a call resolves before it sends anything: the backend, its API URL and the
public page of the contract. The `route` option lets you pick the backend or the URL yourself. See
[Routing](../reference/routing.md#route).

## `routedBy`

This field says which rule chose the backend: `caller`, `table`, `fallback` or `api-url`. The
`verify.routed` event and a dry run's result carry it. See
[Routing](../reference/routing.md#how-a-chain-resolves).

## Routing table

The routing table lists, for each chain it knows, the backends that serve it, in the order a call
tries them. It ships with the package. See
[Routing: the routing table](../reference/routing.md#the-routing-table).

## Server handler

The server handler is `createVerifyHandler` from `explorer-verify/server`. It runs on your server,
takes verify requests from a browser app and adds the Etherscan key there. See
[Server handler](../reference/server-handler.md).
