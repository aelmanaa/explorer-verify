---
"explorer-verify": minor
"@explorer-verify/cli": minor
---

Breaking: `error.toJSON()`, `JSON.stringify(error)` and the JSON envelope now hold the error's
`details`, redacted, after `handle` and `handles`. A handle in them is in its one-line form. Read
`error.details.issues` of `invalid-input` or `error.details.candidates` of `incomplete-input`
instead of parsing the message. `ErrorJson` is now a union keyed by `code`, so checking
`json.code` narrows `json.details`. New types: `ErrorDetailsJson`, `DetailsJsonOf` and
`ErrorJsonFields`. The envelope schema requires `details` and lists each code's fields.

The breaking changes:

- Code that compares the error object key for key sees `details`. An `ErrorJson` built by hand in
  TypeScript needs `details` with its code.
- `toEnvelope()` and `exitCodeOf()` refuse, with `invalid-input`, an error object without
  `details`, a `VerifyEachResult<ErrorJson>` whose error objects lack them, and a
  `not-confirmed`, `job-not-found` or `unknown-state` error object without `handle`. Error JSON
  stored by an earlier version and fed back in is refused.
- `toEnvelope()` rebuilds the details of every error: a required number that is not finite
  refuses it, an optional one is left out, and a metadata hash of another shape becomes empty.
  For an error object it did not build, it also cuts long strings and lists and rebuilds
  `docsUrl` from the code. This copy's own errors keep their full details, so `toJSON()` equals
  the envelope.
- `error.details` is frozen, and a non-finite optional number in it is left out. Its arrays,
  `issues`, `candidates`, `attempts` and `handles`, are `readonly` in `ErrorDetails` and
  `ErrorDetailsJson`.
- The `invalid-input` message of `validateInput()` states the first issue, such as "The input is
  invalid: address must be 0x followed by 40 hex digits."
- Messages give a time budget in seconds from 1 s, such as "the 4 s budget ran out".
- The dry-run log line no longer names `verify()`.

The CLI prints a hint of its own for every error code, with its flags and environment variables:
`missing-api-key` names `ETHERSCAN_API_KEY` or `ROUTESCAN_API_KEY` and `--api-key-file`, and
`incomplete-input` names `--contract` with the candidate contracts. With `--json`, an error that
`explorer-verify status` resumes as it is, such as `not-confirmed`, carries `nextCommand`; it
never submits. Without `--json`, stderr lists the issues and candidates under the error line, the
next command on a `next:` line, and shows control characters as `\uXXXX`. The JSON log line of an
error gains a `nextCommand` field. The usage hint reads "lists every command and option", and the
dry-run summary says "a run without --dry-run would submit". The errors of `--foundry` and
`--hardhat` keep the helper's message and carry their issues, renamed to the CLI's flags, in
`details`. Each error page has a "From the CLI" line.

Issue: https://github.com/aelmanaa/explorer-verify/issues/214
