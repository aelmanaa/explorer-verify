# 0049: The error JSON keeps the details, and the CLI gives its own hints and the next command

Status: Accepted (2026-11-06). Reverses the "`toJSON()` never includes `details`" point of
[decision 0009](0009-options-handle-and-errors.md), section 3. Amends R-AX-5, R-AX-10, R-SEC-1 and the error wording of
[decision 0051](0051-cli-reads-foundry-and-hardhat-projects.md).

Research: [narrowing errors, a brand across copies, and the cost of the hint text](../research/2026-11-05-error-narrowing-and-brand.md)
for how `details` narrows by code and what the class costs in a bundle;
[clig.dev, Errors](https://clig.dev/#errors), read on 2026-11-06, for "catch errors and rewrite
them for humans". The repros are in issue #214: each ran the CLI against its test fake explorer.

## Context

`ExplorerVerifyError.toJSON()`, and so the envelope, held `code`, `message`, `hint`, `docsUrl`,
`retryable` and `handle`. Decision 0009 left `details` out so that `JSON.stringify(error)` was
safe to print. Since then the constructor redacts every string in `details` (R-SEC-1), so that
reason no longer holds, and the data the hints point at was lost: `issues`, `candidates`,
`retryAfterMs`, `status` and `excerpt` were not in `--json`, in text mode or with `--verbose`.

The CLI printed the library's hints, which name `checkStatus()`, `details.handle`, `apiKeys` and
`options.contract`. A person at a shell or an agent cannot act on them. Only one hint, for a chain
without a row, was rewritten.

## Decision

1. `toJSON()` adds `details`, last, after `handle` and `handles`. Its fields are those of
   `ErrorDetails`, with each handle in its one-line form (`ErrorDetailsJson`). `ErrorJson` becomes
   a union keyed by `code`, so checking `json.code` narrows `json.details` as checking
   `error.code` narrows `error.details`. `DetailsJsonOf<C>` and `ErrorJsonFields` are exported.
   `toJSON()` builds the JSON details from the handle lines it already computes, with no clone:
   `structuredClone` is missing from some runtimes the library targets, such as Hermes.
2. The constructor freezes `details`, with every nested array and object, so an edit after
   construction cannot change what `toJSON()` prints. An optional number that is not finite,
   such as `retryAfterMs` of `NaN`, `Infinity` or `"12"`, is left out.
3. `toEnvelope` rebuilds the details of every error object, field by field from the fields its
   code declares, every string redacted again with its `secrets`:
   - for an error object it did not build, such as one from another copy or a server handler's
     answer, every string is also cut to 1,000 characters, every excerpt to 300 and every list to
     50 items; this copy's own errors keep their full details, so `toJSON()` equals the envelope
     (R-AX-5), and `incomplete-input` lists up to 1,000 missing sources;
   - a metadata hash is kept only in the shape of an IPFS CID or a Swarm hash;
   - a required number that is not finite refuses the error object with `invalid-input`; an
     optional one is left out, so the JSON never holds `null` for a number;
   - a handle comes from the checked top-level `handle` or `handles`, never from the details;
   - the message and the hint of a foreign error object are cut to 2,000 characters, and
     `docsUrl` is rebuilt from the code: a URL from another copy or a server is never passed on.

   An error object without `details` with its own code, or a `not-confirmed`, `job-not-found` or
   `unknown-state` object without `handle`, is refused with `invalid-input`. The envelope schema
   requires `details` and lists each known code's fields.

4. The input builders know no key, so an error they throw holds what the input holds, redacted by
   the shape rules only. The CLI's scrub of both streams and `toEnvelope(outcome, { secrets })`
   remove the keys the caller knows; a key nobody passes is caught only by the shape rules
   (R-SEC-1). The details arrays are `readonly` in `ErrorDetails` and `ErrorDetailsJson`, to match
   the freeze.
5. The `invalid-input` message of `validateInput` states the first issue in full and names the
   fields of the others. Time budgets in messages read in seconds from 1 s; the number stays in
   `details.timeoutMs`. The excerpt of a server handler's answer is the caller's own handler body
   and is kept as it is in `details`; its message never repeats an unknown refusal code
   (decision 0048).
6. The CLI has one hint layer, `hints.ts`. A hint the CLI built itself is kept. The library's
   default hint becomes the code's CLI hint. Any other library hint is rewritten word by word,
   such as `options.contract` to `--contract`, and when a word with no CLI form is left, such as
   `details.` or `apiKeys`, it becomes the code's CLI hint too. The words and their CLI forms are
   one table. This amends [decision 0051](0051-cli-reads-foundry-and-hardhat-projects.md): the
   build helpers' errors keep their message, their issues are renamed to the CLI's flags in
   `details`, and their hints go through the same layer. A CLI hint is filled in only with values
   that cannot hold a key: a handle, contract names, a source path, a backend name. Each error
   page states it on a "From the CLI" line, and a test checks the page against the code. The CLI's
   usage hint reads "lists every command and option", so no CLI hint holds `options.`.
7. The CLI's error envelope gains `nextCommand`, an argv array after `error`, when one command
   resumes the run as it is: `explorer-verify status <handle>`, with `--json` when the run had it,
   for `not-confirmed` and for `cancelled` with one handle. It never submits. It is left out when
   the command would need more than the CLI repeats: a handle that does not parse, such as one
   whose job id was redacted; a handle of `etherscan-compatible`, which needs the API URL; and a
   run that read its key from `--api-key-file` or `--api-key-stdin`, whose hint then says to add
   the same key flag. Text mode prints it on a `next:` line, each word that a shell would read
   otherwise in single quotes. It lists the issues and candidates under the error line, and shows
   every control character of a value as `\uXXXX`, so text from an explorer or a build file cannot
   forge a line or send an ANSI or OSC sequence.

## Size

Measured with esbuild 0.28.2 and Node 24.21.0 zlib on 2026-11-06, in bytes gzipped. The entries
of `size-budget.json` on main dc75e89 and on main dc75e89 plus this change:

| Entry                 | Main dc75e89 | This change | Ceiling | New ceiling |
| --------------------- | ------------ | ----------- | ------- | ----------- |
| `verify`              | 16,504       | 16,785      | 19,738  | 19,738      |
| `checkStatus`         | 14,216       | 14,368      | 17,006  | 17,006      |
| `verifyEach`          | 18,206       | 18,481      | 18,316  | 22,178      |
| `buildVerifyInput`    | 13,477       | 13,702      | 16,026  | 16,026      |
| `linkProxy`           | 13,220       | 13,374      | 13,512  | 13,512      |
| `createVerifyHandler` | 13,869       | 14,047      | 14,429  | 14,429      |

`verify` grows by 281 bytes: the frozen details, the dropped non-finite numbers, the JSON details
in `toJSON()` and a second build of input errors that a later review removed (point 4); without
it, on main d88f582, `verify` is 16,784. A first version that cloned the details with `structuredClone` and kept
a table with an entry per code cost more and ran on fewer runtimes. The `verify` and
`checkStatus` ceilings were already reset on main by #248, after #246 and #247; of the
`checkStatus` growth from 11,730, when its first ceiling was set, to 14,368, this change adds 152.

The rows of `name-budget.json`, on main f7c12bf and on main f7c12bf plus this change, which the
rebase onto dc75e89 left within a few bytes:

| Row                            | Main f7c12bf | This change | Ceiling | New ceiling |
| ------------------------------ | ------------ | ----------- | ------- | ----------- |
| `toEnvelope`, esbuild split    | 8,236        | 9,165       | 8,949   | 10,998      |
| `toEnvelope`, esbuild one file | 7,877        | 8,760       | 8,502   | 10,512      |
| `toEnvelope`, Rollup           | 7,672        | 8,551       | 8,344   | 10,262      |
| `exitCodeOf`, esbuild split    | 7,732        | 8,648       | 8,703   | 10,378      |
| `exitCodeOf`, esbuild one file | 7,412        | 8,295       | 8,261   | 9,954       |
| `exitCodeOf`, Rollup           | 7,217        | 8,090       | 8,106   | 9,708       |

The rebuild from JSON in point 3 is in `toEnvelope` and `exitCodeOf` only, which share it, and
costs about 880 bytes there: the table of each code's fields, the checks of numbers and hashes,
and the caps.

These costs are what this decision asks for: `toJSON()` must carry the details, and the rebuild
and its caps keep a foreign error's details bounded (R-SEC-1). So, by the rule of
[decision 0014](0014-measured-bundle-ceilings.md), `verifyEach` and these rows are measured again
and their ceilings set to the measured size plus 20%. `verifyEach` was over its old ceiling by
only 165 bytes; resetting it is the rule's step, not a sign of a large growth. After the
rebase onto main 49ce96c (#250), `linkProxy` measured 13,528, 16 bytes over its ceiling of
13,512, which was set from 11,260; its ceiling becomes 16,234 the same way. The three rows of
each name are measured again together, so they stay from one run.

## Alternatives considered

| Option                                             | For                               | Against                                                                   |
| -------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| Keep `details` out; copy `issues` into the message | No change to the JSON shape       | Candidates, wait times and excerpts stay lost; agents parse messages      |
| A `cliHint` field next to `hint` in the catalogue  | One table for both                | The core ships CLI text in every bundle; the core names CLI flags         |
| Read the details' handle from the details          | No dependency on top-level fields | Two places to check and redact the same handle; they could disagree       |
| `nextCommand` that repeats the whole verify argv   | Covers retries of every code      | The argv can hold an RPC URL or a key file path; a retry may submit again |

## Consequences

The breaking changes:

- `JSON.stringify(error)`, `toJSON()` and the envelope hold `details`, after `handle` and
  `handles`. Code that compared the error object key for key changes. Within `schemaVersion` 1
  this adds a field.
- `ErrorJson` is a union keyed by `code` with a required `details`. An `ErrorJson` built by hand
  in TypeScript needs `details` with its code.
- `toEnvelope()` and `exitCodeOf()` refuse, with `invalid-input`, an error object without
  `details`, and a `VerifyEachResult<ErrorJson>` whose error objects lack them. That includes
  error JSON stored by an earlier version and fed back in.
- `toEnvelope()` refuses a required number that is not finite, cuts long foreign strings and
  lists, and rebuilds `docsUrl` from the code.
- `error.details` is frozen.
- The CLI's JSON log line of an error gains a `nextCommand` field, and its usage hint reads
  "lists every command and option".
- The `invalid-input` message of `validateInput()` and the time budgets in messages read
  differently.

Other consequences:

- A reader of `--json` reads `error.details.issues` or `error.details.candidates` instead of the
  message, and runs `nextCommand` as it is.
- The CLI's hints change with its flags; the page test keeps the docs in step.
