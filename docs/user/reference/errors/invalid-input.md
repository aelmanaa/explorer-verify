# invalid-input

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the input failed validation, or a handle did not parse. From `buildVerifyInput`, it also
means a document of no known shape, documents from different builds (their build ids or full
compiler versions differ), a contract path that is not in the sources, or a local path in the
compiler input. The issue gives the position of a local path, never the path. A handle with any
field it does not know, a URL included, is rejected: a handle never sets the host. All unknown
fields are reported as one issue on `handle` that gives their count, not their names.

From the CLI, it also means a command line or request the CLI refuses, such as `verify` without a
target: a submit needs `--backend <name>` or `--backend auto` (`route.backend` with
`--input-json`), and `--api-url` needs `--backend`. The hint lists the backends the chain's row
lists and what `auto` would pick. Run with `--dry-run` to see the target without submitting.

Fix: correct each field listed in `details.issues` (`field` and `message`), then call again. For a
handle, pass it exactly as `verify()` or a `not-confirmed` error returned it.

Default hint: Fix the fields listed in details.issues, then call again.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
