# 2026-11-02: CLI output and SDK logging conventions

Audience: contributors who need the evidence behind the CLI output contract (R-AX-5, R-AX-6,
R-AX-9, R-AX-12, R-AX-14 to R-AX-16), the library logger and events (R-DX-5, R-DX-6) and
[decision 0010](../decisions/0010-logger-fields-events-and-silent-default.md). Sources read and
commands run on 2026-11-02.

Question: how should explorer-verify split stdout and stderr, report progress and errors in JSON
mode, react to a non-terminal, expose verbosity, take a whole request as JSON, and log from a
runtime-neutral library without leaking a key?

## Method

Every factual claim carries a reference into [Sources](#sources):

- `[Sn]` is a document or source file, with its URL and the date read.
- `[Ln]` is a command run on 2026-11-02, with the tool and its version.

Terraform, Stripe CLI, Wrangler and Vercel CLI were not run; statements about them come from their
docs only. Lines that state what explorer-verify adopts point to a requirement or a decision, not
to a source.

## A. CLI output

### A1. stdout and stderr

Primary sources:

- POSIX: stdin is "for conventional input", stdout "for conventional output", stderr "for
  diagnostic output" [S1].
- GNU Coding Standards, `--help`: "should output brief documentation for how to invoke the
  program, on standard output, then exit successfully." [S2]
- clig.dev: "The primary output for your command should go to `stdout`." "Anything that is
  machine readable should also go to `stdout`." "Log messages, errors, and so on should all be sent
  to `stderr`." [S4]

What each tool does:

| Tool                  | Machine output                                               | Logs, progress, errors                                                               | Evidence                                                                                   |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| gh 2.92.0             | `--json fields` and `--jq` on stdout                         | Errors on stderr, also with `--json`. `GH_DEBUG` output and update notices on stderr | `gh repo view <missing> --json name` gave empty stdout, the error on stderr, exit 1 [L1]   |
| kubectl v1.37.0       | `-o json\|yaml\|jsonpath\|...` on stdout                     | Errors and klog lines on stderr; `-v=N` sets verbosity                               | Against an unreachable server: klog lines on stderr, exit 1 [L2]                           |
| aws-cli 2.37.3        | `--output json\|text\|table\|yaml` on stdout                 | Errors on stderr, also with `--cli-error-format json`                                | With a fake key: JSON error `{ "Code", "Message" }` on stderr, stdout empty, exit 254 [L3] |
| docker 29.5.2         | `--format json` on stdout                                    | Errors on stderr                                                                     | `docker inspect <missing>` printed `[]` on stdout, the error on stderr, exit 1 [L4]        |
| docker buildx v0.36.1 | The build result                                             | `--progress=rawjson` writes BuildKit status as JSON Lines to stderr                  | 0 bytes on stdout, 5,828 bytes of JSON Lines on stderr [L4]                                |
| jq 1.8.1              | The result on stdout                                         | Parse errors on stderr; `-e` sets the exit code from the last output                 | `jq .` on bad input exited 5 with the message on stderr [L5]                               |
| Terraform             | `-json` UI stream; `validate -json` one object               | `TF_LOG` logs on stderr                                                              | "detailed logs to appear on `stderr`" [S10]; [S8], [S9]                                    |
| Vercel CLI            | "When deploying, `stdout` is always the Deployment URL."     | Errors on stderr; the docs show `2>error.txt`                                        | [S12]                                                                                      |
| Stripe CLI            | `stripe listen --print-json` prints "JSON objects to stdout" | Not stated on that page                                                              | [S15]                                                                                      |
| Node `util.debuglog`  | n/a                                                          | `NODE_DEBUG=evtest` printed `EVTEST <pid>: hello x` on stderr                        | [L8], [S42]                                                                                |
| `debug` package       | n/a                                                          | "By default `debug` will log to stderr"                                              | [S40]                                                                                      |
| `@azure/logger`       | n/a                                                          | "By default, logs are sent to stderr"                                                | Source comment [S35]                                                                       |

Other observed behaviour:

- kubectl v1.37.0, given an unreachable `--server` and no credentials, printed
  `Please enter Username:` on stdout and then exited with `error: EOF` on stderr, also with stdin
  redirected from `/dev/null` [L2].
- npm 11.19.0 with `--json` writes the error object to stdout and a human error to stderr [L6].
- Terraform's `validate -json` page states that "errors occurring before validation begins" are
  not JSON [S9].

### A2. Machine output modes

| Pattern                                     | Example                                                                                                | Shape                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json` with field selection               | gh `--json number,title --jq '.[0].number'` [L1]                                                       | One document. With no field list, gh prints the available fields [L1]                                                                                                                                                                                                                                 |
| `-o` format switch                          | kubectl `-o json\|yaml\|name\|jsonpath\|custom-columns\|wide` [L2]                                     | One document per call; `--output-watch-events` for watches [L2]                                                                                                                                                                                                                                       |
| Versioned event stream on stdout            | Terraform `-json` on `plan`, `apply`, `refresh`, `test` [S8]                                           | One JSON object per line with `@level`, `@message`, `@module`, `@timestamp` and `type`. The first message is `type: version` with `ui` (`"1.0"` as of 1.1.0). Consumers "ignore any object properties with unrecognized names" and "reject any input which reports an unsupported major version" [S8] |
| Event stream on stdout with a final message | cargo `--message-format json` [S11]                                                                    | "The output goes to stdout in the JSON object per line format", a `reason` field, a final `build-finished` with `success` [S11]                                                                                                                                                                       |
| Event stream on stdout                      | `go test -json` [L9]                                                                                   | JSON Lines on stdout with `Time`, `Action`, `Package`, `Test`, `Output`; stderr empty [L9]                                                                                                                                                                                                            |
| Event stream on stderr                      | docker buildx `--progress=rawjson` [L4]                                                                | JSON Lines on stderr; the build result is separate [L4]                                                                                                                                                                                                                                               |
| Event file                                  | Wrangler `WRANGLER_OUTPUT_FILE_PATH` [S14]                                                             | Writes output data as ND-JSON to a file, apart from terminal output [S14]                                                                                                                                                                                                                             |
| JSON by default, NDJSON for pages           | Google Workspace CLI `gws`, whose README says it is "not an officially supported Google product" [S18] | "All output ... is structured JSON"; `--page-all` gives "one JSON line per page (NDJSON)" [S18]                                                                                                                                                                                                       |

Two designs fit a long-running verify (validate, route, lookup, submit, poll, result):

1. The final envelope on stdout, progress as JSON Lines on stderr, as docker buildx does for
   progress [L4]. stdout stays one document, so `| jq .result.status` and `2>/dev/null` keep
   working. The caller reads two streams. A reader of stderr parses only lines that start with
   `{`, because the runtime can write other text there. The cargo docs suggest the same
   workaround for output that mixes JSON with other text [S11].
2. One event stream on stdout whose last line is the result, as Terraform [S8], cargo [S11] and
   `go test` [L9] do. One ordered stream that is easy to save to a file. stdout is then not one
   document, and every consumer picks the final line.

explorer-verify takes design 1 (R-AX-14). A verify result is small and arrives once; progress
matters mostly for the resume handle (R-FLOW-5) and for a person watching.

### A3. Errors in JSON mode

| Tool                                     | Where the JSON error goes                                                                                    | Exit code                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| npm 11.19.0 `view <missing> --json`      | stdout: `{"error":{"code":"E404","summary":...,"detail":...}}`; a human error also on stderr [L6]            | 1 [L6]                       |
| pnpm 12.16.1 `view <missing> --json`     | stdout: `{"error":{"code":"ERR_PNPM_FETCH_404","message":...}}`; stderr empty [L7]                           | 1 [L7]                       |
| Terraform `validate -json`               | stdout: `valid: false`, `error_count`, `diagnostics[]`, `format_version` [S9]                                | Not stated on that page [S9] |
| Terraform `-json` streams                | stdout: `type: diagnostic`, `@level: error` [S8]                                                             | Not stated on that page [S8] |
| gws                                      | "All output, success, errors ... is structured JSON"; hints on stderr [S18]                                  | 0 to 5 by failure type [S18] |
| gh 2.92.0                                | stderr, plain text [L1]                                                                                      | 1, 2 cancelled, 4 auth [L1]  |
| aws-cli 2.37.3 `--cli-error-format json` | stderr: `{ "Code", "Message" }` [L3]                                                                         | 252 to 255 by class [L3]     |
| Salesforce CLI                           | `SFDX_JSON_TO_STDOUT` (v44) moved JSON errors to stdout; the post states it becomes the default in v48 [S19] | Not checked                  |

Both placements are in use: stdout for npm [L6], pnpm [L7], Terraform [S8] [S9], gws [S18] and
Salesforce CLI [S19]; stderr for gh [L1] and aws-cli [L3]. explorer-verify puts the error
envelope on stdout (R-AX-5), so a caller always parses one document from stdout, whatever the exit
code.

Two cases need a rule of their own:

- A usage error found before the parser has read `--json`. Terraform's docs describe the same case
  for `validate -json` [S9]. The CLI scans the arguments for `--json` before parsing them.
- A cancelled run (exit 130). Decision 0009 keeps abort out of the error catalogue, so the CLI
  writes its own error code for it.

### A4. Terminals, colour and prompts

| Signal                       | Rule                                                                                                                                                 | Source |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `NO_COLOR`                   | When "present and not an empty string (regardless of its value)", no ANSI colour. User config and command-line flags "should override" it            | [S5]   |
| `FORCE_COLOR`                | When present and non-empty, force colour. The reference C code checks it after `NO_COLOR`                                                            | [S6]   |
| `CLICOLOR`, `CLICOLOR_FORCE` | `CLICOLOR` set: colour only on a terminal. `CLICOLOR_FORCE` set: colour "no matter what". `NO_COLOR` overrides `CLICOLOR_FORCE`                      | [S7]   |
| `TERM=dumb`                  | Disable colour                                                                                                                                       | [S4]   |
| Terminal state               | Disable colour if "`stdout` or `stderr` is not an interactive terminal". "If `stdout` is not an interactive terminal, don't display any animations." | [S4]   |
| Prompts                      | "Only use prompts ... if `stdin` is an interactive terminal." "If `--no-input` is passed, don't prompt."                                             | [S4]   |
| gh environment               | gh reads `GH_PROMPT_DISABLED`, `GH_FORCE_TTY`, `CLICOLOR`, `CLICOLOR_FORCE` and `NO_COLOR`                                                           | [L1]   |
| `--non-interactive`          | Vercel: "When the CLI detects that it is running under an agent, non-interactive mode is the default."                                               | [S13]  |
| `CI`                         | GitHub Actions: "Always set to `true`."                                                                                                              | [S17]  |
| `FORCE_COLOR=0`              | Wrangler: disables colour                                                                                                                            | [S14]  |
| `--progress=auto`            | docker buildx: `tty` mode on a terminal, `plain` otherwise; `BUILDKIT_PROGRESS` sets it                                                              | [S16]  |

The three colour conventions order `FORCE_COLOR`, `CLICOLOR_FORCE` and `NO_COLOR` differently
[S5] [S6] [S7]. explorer-verify reads `NO_COLOR`, `TERM=dumb`, `CI` and its own `--color` flag
(R-AX-6), and lets the flag win, as no-color.org asks [S5].

Progress goes to stderr, so the spinner decision follows stderr's terminal state, and colour on
each stream follows that stream. In a terminal, `explorer-verify verify --json > out.json` leaves
stderr a terminal, and a spinner there writes nothing into the file. `2> log.txt` with stdout on a
terminal must not write spinner frames into the log file.

### A5. Verbosity

- clig.dev: "`-q`, `--quiet`" to "suppress all non-essential output"; "`-d`, `--debug`: Show
  debugging output"; "`-v`: This can often mean either verbose or version"; "Don't print log level
  labels ... unless in verbose mode." [S4]
- Terraform: `TF_LOG=TRACE|DEBUG|INFO|WARN|ERROR` or `JSON`, documented as not a stable
  interface, on stderr; `TF_LOG_PATH` appends to a file [S10].
- gh: `GH_DEBUG=1` prints verbose output on stderr, `GH_DEBUG=api` adds HTTP traffic [L1].
- kubectl: `-v=N` numeric verbosity, `--warnings-as-errors` [L2].
- aws: `--debug` [L3].
- Vercel: `--debug` or `-d`; `-v` is `--version` [S13].
- Wrangler: `WRANGLER_LOG` levels, default `log`; `WRANGLER_LOG_PATH` for debug logs [S14].
- gws: logs to stderr are off by default; `GOOGLE_WORKSPACE_CLI_LOG` turns them on [S18].
- Node: `NODE_DEBUG=<section>` [S42]. The `debug` package: `DEBUG=ns:*` in Node,
  `localStorage.debug` in browsers [S40].

explorer-verify adopts `--quiet`, `--verbose` and `EXPLORER_VERIFY_LOG` (R-AX-15). `-v` stays
unbound because clig.dev notes it can mean verbose or version [S4].

### A6. Taking a whole request as JSON

- Claude API "Define tools": `input_schema` is JSON Schema; "Return semantic, stable identifiers"
  [S22].
- MCP specification 2025-11-25, Tools: `inputSchema` (JSON Schema, 2020-12 by default) and an
  optional `outputSchema`; with an output schema, "Servers MUST provide structured results that
  conform"; tool execution errors are results with `isError: true` [S24].
- Anthropic, "Writing effective tools for agents": "return only high signal information"; Claude
  Code limits tool responses to 25,000 tokens by default [S21].
- Claude Code MCP docs: a warning above 10,000 tokens of MCP tool output, and a default limit of
  25,000 tokens that `MAX_MCP_OUTPUT_TOKENS` changes [S23].
- aws-cli 2.37.3: `--generate-cli-skeleton input|yaml-input|output` prints the request shape with
  `[REQUIRED]` comments; `--cli-input-json` takes the whole request; an unknown key gave
  `Unknown parameter in input: "Bogus"` and exit 252 [L3].
- kubectl v1.37.0: `kubectl explain` describes resource fields from the server's OpenAPI document
  [L2].
- gws: `gws schema drive.files.list` prints a method's request and response schema; `--params` and
  `--json` take JSON; `--dry-run` previews the request [S18].
- gh 2.92.0: `--json` with no field list prints the available fields [L1].

explorer-verify adopts `--input-json <file|->` validated against a JSON Schema that ships with the
package (R-AX-16). The same schemas can become the `inputSchema` and `outputSchema` of an MCP tool
[S24] if decision 0007's deferral of an MCP server is reversed.

### A7. Secrets on stdin

- docker: `docker login --password-stdin` is described as "Take the Password or Personal Access
  Token (PAT) from stdin", with the example
  `cat ~/my_password.txt | docker login --username foo --password-stdin` [S44].
- gh: `gh auth login --with-token` is described as "Read token from standard input", with the
  example `gh auth login --with-token < mytoken.txt` [S45].
- clig.dev: "Do not read secrets directly from flags" [S4].

explorer-verify adds `--api-key-stdin` next to the environment variables and `--api-key-file`
(R-AX-9).

## B. Library logging

### B1. Logger interfaces and defaults

| Library                                    | Option                                    | Interface shape                                                                      | Default                                                         | Environment control                                                                    |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| AWS SDK JS v3, smithy `Logger` [S29] [S30] | client `logger`                           | `trace?`, `debug`, `info`, `warn`, `error`, each `(...content: any[]) => void`       | The developer guide turns logging on by passing `logger`        | None on that page                                                                      |
| Octokit core [S32]                         | `log`                                     | `debug`, `info`, `warn`, `error`, each `(message: string) => unknown`                | `debug` and `info` do nothing; `warn` and `error` use `console` | None                                                                                   |
| OpenAI Node v7.47.0 [S33] [S43]            | `logger`, `logLevel`                      | `(message: string, ...rest: unknown[]) => void` for `error`, `warn`, `info`, `debug` | `globalThis.console`, level `warn`                              | `OPENAI_LOG`; `logLevel` overrides it                                                  |
| Anthropic TS sdk-v1.4.0 [S34]              | `logger`, `logLevel`                      | The same shape; levels `off`, `error`, `warn`, `info`, `debug`                       | Level `warn`, console                                           | `ANTHROPIC_LOG`                                                                        |
| `@azure/logger` [S35]                      | `setLogLevel`, `AzureLogger.log` override | A `debug`-style function per namespace                                               | Off; output to stderr                                           | `AZURE_LOG_LEVEL`, which takes precedence over `DEBUG`                                 |
| Google Cloud Node logging utils [S37]      | `setBackend()`                            | Node, `debug`-package or structured JSON backends                                    | Off                                                             | `GOOGLE_SDK_NODE_LOGGING`; the README calls it "not intended to be a stable interface" |
| Stripe Node [S39]                          | `stripe.on('request' \| 'response', fn)`  | Event objects; bodies only with `emitEventBodies`                                    | The README configuration table lists no logging option          | None found                                                                             |
| `debug` [S40]                              | `debug('ns')`                             | A function with `enabled`, `log`, `extend`                                           | Off; stderr in Node                                             | `DEBUG=ns:*,-ns:x`; `localStorage.debug` in browsers                                   |
| pino 10.4.0 [S41]                          | `logger.child(bindings)`                  | `([mergingObject], [message], [...interpolationValues])`                             | n/a                                                             | n/a                                                                                    |
| Node [S42]                                 | `util.debuglog(section)`                  | A function                                                                           | Off; stderr                                                     | `NODE_DEBUG`                                                                           |

Two defaults are in use: AWS SDK JS v3, Azure, Google Cloud, `debug` and `NODE_DEBUG` print nothing
until asked; Octokit, OpenAI and Anthropic print warnings and errors to the console (table
sources above).

OpenAI's README: "All log messages are intended for debugging only. The format and content of log
messages may change between releases." [S43]

Argument order, with `info("submitted", fields)` [L10]:

- pino 10.4.0 printed `{"level":30,"msg":"submitted"}`. Its docs define arguments after the
  message as printf interpolation values [S41]. With pino's own order, `info(fields, "submitted")`,
  the fields appeared in the output [L10].
- winston 3.19.0 merged the fields into the record:
  `{"backend":"sourcify","chainId":1,"event":"verify.submitted","level":"info","message":"submitted"}`
  [L10].
- `console.info` printed the message and the object [L10].

So a `(message, fields?)` logger works with console and winston [L10], and matches the
message-first shape of Octokit [S32] and the smithy `Logger` [S30]. A pino logger takes a one-line
adapter, `info: (m, f) => log.info(f ?? {}, m)`: called with `("submitted", fields)` it printed
`{"level":30,"event":"verify.submitted","backend":"sourcify","chainId":1,"msg":"submitted"}`, and
with the message alone `{"level":30,"msg":"submitted"}` [L11].

The reverse order, `info(fields, "submitted")`, gave
`{"level":"info","message":{"backend":"sourcify","chainId":1,"event":"verify.submitted"}}` in
winston 3.19.0, with the text `submitted` absent, and `console.info` printed the object before the
text [L11].

### B2. Structured fields, events and OpenTelemetry

- OpenTelemetry, "Instrumentation libraries": "Libraries should only use the OpenTelemetry API";
  the API "is no-op and very performant when there is no SDK in the application"; "When in doubt,
  don't instrument"; verbose spans go "behind a configuration option" and are off by default
  [S25].
- OpenTelemetry Logs Data Model: `SeverityNumber` ranges TRACE 1-4, DEBUG 5-8, INFO 9-12, WARN
  13-16, ERROR 17-20, FATAL 21-24; fields `Body`, `Attributes`, `EventName`. "A log record with a
  non-empty event name is an Event." `EventName` "SHOULD uniquely identify the event structure"
  [S27].
- OpenTelemetry semantic conventions, Events: "Event names MUST NOT include dynamic values";
  details go in attributes [S28].
- OpenTelemetry Logs API: designed "primarily ... for library authors to build log appenders"
  [S26].

Consequences for explorer-verify: the four levels map to severities 5, 9, 13 and 17 [S27]. Flat
fields of type `string | number | boolean | null` map to attributes without conversion [S27]. A
fixed lowercase, dot-separated name such as `verify.submitted` meets the event naming rules
[S28]. A dependency on `@opentelemetry/api` in the core would count against the bundle budget of
decision 0008. Design reasoning, not tested: an `onEvent` callback can pass each event to an
OpenTelemetry logger as an event name plus attributes, without a dependency in the core.

Correlation: OpenAI and Anthropic attach a per-request log id and record `retryOf` for a retry
[S33] [S34]. pino [S41] and OpenAI's README [S43] use `logger.child({ ... })` for context the
caller chooses. In explorer-verify the handle identifies a verification once the explorer accepts
it; before that a random id would break deterministic output (R-AX-12), so call-level context
stays with the caller's child logger.

### B3. Secret redaction

| Library       | Mechanism                                                                                                                                                                                         | Source |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Anthropic TS  | Header values replaced by `***` for `authorization`, `proxy-authorization`, `api-key`, `x-api-key`, `x-amz-security-token`, `cookie`, `set-cookie`                                                | [S34]  |
| OpenAI Node   | The same header list plus `x-session-token`, `x-session-id`, `x-auth-token`, `x-id-token`. `redactURL` clears user name, password and fragment and sets credential-like query parameters to `***` | [S33]  |
| Azure core    | An allow-list: headers not on the list and every query value except `api-version` are written as `REDACTED`; SDKs add names to the list. "Request and response bodies are never logged." [S35]    | [S36]  |
| AWS SDK JS v3 | The logger middleware passes input and output through per-command `inputFilterSensitiveLog` and `outputFilterSensitiveLog`, seen in published builds of `@aws-sdk/middleware-logger`              | [S31]  |
| pino          | `redact: ['path.to.key', 'headers["x-api-key"]']` replaces values with `[Redacted]` or a custom `censor`                                                                                          | [S41]  |

Etherscan v2 takes the key as the `apikey` query parameter
([explorer APIs note](2026-11-02-explorer-apis.md)), so URL redaction matters more for
explorer-verify than header redaction. Decision 0010 sends every log message, event, error and
result through one redaction step.

### B4. Runtime-neutral constraints

- `debug` turns on browser output through `localStorage.debug` [S40]; OpenAI and Anthropic take
  `logLevel` in the constructor and read their environment variable as a fallback [S33] [S34];
  Azure offers `setLogLevel()` [S35].
- The explorer-verify core never reads `process.env` (AGENTS.md, R-RUN-1). It takes `logger` and
  `onEvent` from `VerifyOptions`; the CLI maps its flags and `EXPLORER_VERIFY_LOG` to them. A
  browser caller passes `console` or its own logger.
- The core has no stream. The CLI's logger and event writer write to `process.stderr`.

## Could not verify

- Terraform was not run. The machine-readable UI page does not name the stream or the exit codes
  for `-json` [S8]; the exit codes of `validate -json` are not on that page [S9].
- kubectl: whether a kubeconfig that holds credentials stops the `Please enter Username:` prompt
  was not run.
- Stripe CLI, Wrangler and Vercel CLI were not run; their stream behaviour comes from docs only.
- AWS SDK JS v3: the current source file of the logger middleware was not found; the filter
  behaviour comes from published package diffs [S31]. The developer guide does not state the
  default when no `logger` is passed [S29].
- Whether `--cli-input-json` values or command-line values win in aws-cli was not tested; it needs
  credentials.
- Google Cloud Node: the statement that debug logs can hold request payloads comes from a
  third-party package page [S38], not from the Google README [S37].
- Salesforce CLI's current `--json` error stream was not checked; only the 2020 change is sourced
  [S19].
- Only the Stripe Node README was read [S39]; the source was not searched for a logging option.
- docker buildx `--progress=rawjson` was observed writing to stderr [L4]; the docs do not name the
  stream [S16].
- The output limit of Claude Code's shell tool was not checked; only the MCP limits are sourced
  [S23].

## Sources

### Documents and source files

All read on 2026-11-02 unless another date is given. The last column gives the version or the
date the source states.

| ID  | Source                                          | URL                                                                                                | Version or date                 |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| S1  | POSIX stdin, stdout, stderr                     | https://pubs.opengroup.org/onlinepubs/9799919799/functions/stdin.html                              | IEEE Std 1003.1-2024            |
| S2  | GNU Coding Standards, `--help`                  | https://www.gnu.org/prep/standards/html_node/_002d_002dhelp.html                                   | Updated 2026-04-27              |
| S3  | GNU Coding Standards, errors                    | https://www.gnu.org/prep/standards/html_node/Errors.html                                           | Updated 2026-04-27              |
| S4  | Command Line Interface Guidelines               | https://clig.dev/                                                                                  | Undated                         |
| S5  | NO_COLOR                                        | https://no-color.org/                                                                              | Updated 2026-10-12              |
| S6  | FORCE_COLOR                                     | https://force-color.org/                                                                           | Undated                         |
| S7  | CLICOLOR                                        | https://bixense.com/clicolors/                                                                     | Undated                         |
| S8  | Terraform machine-readable UI                   | https://developer.hashicorp.com/terraform/internals/machine-readable-ui                            | `ui` 1.0 as of Terraform 1.1.0  |
| S9  | Terraform `validate`                            | https://developer.hashicorp.com/terraform/cli/commands/validate                                    | Undated                         |
| S10 | Terraform debugging                             | https://developer.hashicorp.com/terraform/internals/debugging                                      | Undated                         |
| S11 | cargo external tools                            | https://doc.rust-lang.org/cargo/reference/external-tools.html                                      | cargo 1.95.0                    |
| S12 | Vercel `deploy`                                 | https://vercel.com/docs/cli/deploy                                                                 | Updated 2026-09-18              |
| S13 | Vercel global options                           | https://vercel.com/docs/cli/global-options                                                         | Updated 2026-05-28              |
| S14 | Wrangler environment variables                  | https://developers.cloudflare.com/workers/wrangler/system-environment-variables/                   | Undated                         |
| S15 | Stripe CLI `listen`                             | https://docs.stripe.com/cli/listen                                                                 | Undated                         |
| S16 | Docker buildx build                             | https://docs.docker.com/reference/cli/docker/buildx/build/                                         | buildx v0.36.1                  |
| S17 | GitHub Actions variables                        | https://docs.github.com/en/actions/reference/workflows-and-actions/variables                       | Undated                         |
| S18 | Google Workspace CLI                            | https://github.com/googleworkspace/cli                                                             | No release shown                |
| S19 | Salesforce CLI output and scripting             | https://developer.salesforce.com/blogs/2020/02/using-salesforce-cli-output-and-scripting           | 2020-02                         |
| S20 | kubectl reference                               | https://kubernetes.io/docs/reference/kubectl/                                                      | Undated                         |
| S21 | Anthropic, "Writing effective tools for agents" | https://www.anthropic.com/engineering/writing-tools-for-agents                                     | 2025-09-11                      |
| S22 | Claude API, Define tools                        | https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use                   | Undated                         |
| S23 | Claude Code MCP                                 | https://code.claude.com/docs/en/mcp                                                                | Undated                         |
| S24 | MCP specification, Tools                        | https://modelcontextprotocol.io/specification/2025-11-25/server/tools                              | 2025-11-25                      |
| S25 | OpenTelemetry instrumentation libraries         | https://opentelemetry.io/docs/concepts/instrumentation/libraries/                                  | Undated                         |
| S26 | OpenTelemetry Logs                              | https://opentelemetry.io/docs/specs/otel/logs/                                                     | Spec v1.62.0                    |
| S27 | OpenTelemetry Logs Data Model                   | https://opentelemetry.io/docs/specs/otel/logs/data-model/                                          | Stable                          |
| S28 | OpenTelemetry semantic conventions, Events      | https://opentelemetry.io/docs/specs/semconv/general/events/                                        | Development                     |
| S29 | AWS SDK JS v3, logging                          | https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/logging-sdk-calls.html           | Undated                         |
| S30 | smithy `Logger` type                            | https://github.com/smithy-lang/smithy-typescript/blob/main/packages/types/src/logger.ts            | Commit `27bdf42158`             |
| S31 | `@aws-sdk/middleware-logger` 3.495.0 diff       | https://socket.dev/npm/package/@aws-sdk/middleware-logger/diff/3.495.0                             | Secondary source                |
| S32 | Octokit core                                    | https://github.com/octokit/core.js/blob/main/src/index.ts                                          | Commit `6432a6fa68`             |
| S33 | OpenAI Node logging source                      | https://github.com/openai/openai-node/blob/main/src/internal/utils/log.ts                          | Commit `e572875c28`, v7.47.0    |
| S34 | Anthropic TS logging source                     | https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/internal/utils/log.ts         | Commit `ea8d7de0e4`, sdk-v1.4.0 |
| S35 | Azure logger                                    | https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/core/logger                                | Commit `be99b0a0ac`             |
| S36 | Azure sanitizer                                 | https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/core/ts-http-runtime/src/util/sanitizer.ts | Commit `be99b0a0ac`             |
| S37 | Google logging utils README                     | https://github.com/googleapis/gax-nodejs/blob/main/logging-utils/README.md                         | Undated                         |
| S38 | `google-logging-utils` package page             | https://socket.dev/npm/package/google-logging-utils/overview/2.1.1                                 | Secondary source                |
| S39 | Stripe Node README                              | https://github.com/stripe/stripe-node                                                              | Commit `6d5ed967d6`             |
| S40 | debug README                                    | https://github.com/debug-js/debug                                                                  | Commit `666dbc5068`             |
| S41 | pino API and redaction docs                     | https://github.com/pinojs/pino/tree/main/docs                                                      | Commit `b29dbe9782`, 10.4.0     |
| S42 | Node `util.debuglog`                            | https://nodejs.org/api/util.html#utildebuglogsection-callback                                      | Node v24                        |
| S43 | OpenAI Node README, "Logging"                   | https://github.com/openai/openai-node                                                              | Commit `e572875c28`, v7.47.0    |
| S44 | `docker login` reference                        | https://docs.docker.com/reference/cli/docker/login/                                                | Undated                         |
| S45 | `gh auth login` manual                          | https://cli.github.com/manual/gh_auth_login                                                        | Undated                         |

### Local runs

All run on 2026-11-02.

| ID  | Tool and version                                        | Commands                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | gh 2.92.0                                               | `gh help environment`, `gh help exit-codes`, `gh help formatting`, `gh repo view <missing> --json name`, `gh pr list --json ... --jq ...`                                                                                     |
| L2  | kubectl client v1.37.0                                  | `kubectl get pods -o json` and `-o yaml` with no server and with an unreachable server, `kubectl options`, `kubectl explain --help`                                                                                           |
| L3  | aws-cli 2.37.3                                          | `aws help return-codes`, `aws sts get-caller-identity` with a missing profile and with a fake key (`--cli-error-format json`), `--generate-cli-skeleton input` and `yaml-input`, `--cli-input-json '{"Bogus":1}'`, `aws help` |
| L4  | docker 29.5.2, buildx v0.36.1                           | `docker inspect <missing>`, `docker version --format json`, `docker buildx build --progress=rawjson`                                                                                                                          |
| L5  | jq 1.8.1                                                | `jq -e`, `jq .` on bad input                                                                                                                                                                                                  |
| L6  | npm 11.19.0                                             | `npm view <missing> --json`                                                                                                                                                                                                   |
| L7  | pnpm 12.16.1                                            | `pnpm view <missing> --json`                                                                                                                                                                                                  |
| L8  | Node v24.21.0                                           | `NODE_DEBUG=evtest` with `util.debuglog("evtest")`                                                                                                                                                                            |
| L9  | go1.27.1                                                | `go test -json`                                                                                                                                                                                                               |
| L10 | pino 10.4.0, winston 3.19.0, `console` on Node v24.21.0 | Each logger called with `info("submitted", fields)`; pino also with `info(fields, "submitted")`                                                                                                                               |
| L11 | pino 10.4.0, winston 3.19.0, `console` on Node v24.21.0 | The pino adapter `info: (m, f) => log.info(f ?? {}, m)` called with `("submitted", fields)` and with `("submitted")`; winston (JSON format) and `console.info` called with `info(fields, "submitted")`                        |
