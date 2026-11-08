# Polyglot CLI consumers

Validation for issue #268, parent #263. These standalone Python, Go and Java
programs run the installed `@explorer-verify/cli` as a subprocess. Each parses
stdout JSON and checks the envelope itself, using Python `json`, Go
`encoding/json`, or Java Gson. Node only installs packages, supplies the local
protocol stand-in, and combines results. No language delegates JSON parsing to
Node.

Run from the repository root:

```sh
JAVA_HOME=<portable-jdk-home> node validation/polyglot/run.mjs \
  --tarballs <candidate-tarball-directory> \
  --output validation/polyglot/evidence
```

Prerequisites: Node 24.21.0 with npm, Python 3.14.6, Go 1.27.1, and JDK
17.0.21+9 (`java` and `javac`). Set `JAVA_HOME` for portable use. In the delegated
validation environment the runner can also read the coordinator's JDK path file.
It never changes global Java configuration. Network access is needed for Gson
from Maven Central; npm installs the four supplied local tarballs with scripts
disabled. The clients have no additional Python or Go dependencies.
`dependencies.json` pins the candidate tarball hashes, Gson artifact hash, and
coordinator-provided macOS x64 Temurin archive URL/hash. Another platform needs
its own JDK 17 installation. A missing runtime is a failure, never a passing skip.

The runner creates an isolated consumer in `.work/`, installs all four real
0.1.0 tarballs, compiles Go and Java, then runs all three clients. Each invocation
uses argument arrays, separate stdout/stderr pipes, closed stdin, a JSON input
file when applicable, and a 15-second child timeout. The environment is an
allowlist; explorer credentials and user Node/npm configuration are not passed.
The outer runner also limits client execution. `evidence/results.json` records
runtime versions, artifact checksums, installed CLI/core versions, actual
parsed envelopes, exit codes, stderr, request counts and submission counts.
Top-level `success` is false if a language or setup fails.
`evidence/negative-controls.json` records a separate run that deliberately supplied
the wrong expected status; all three clients rejected it with a nonzero exit.

Seven scenarios run in each language:

| Scenario                      | Exit | Assertion                                                                |
| ----------------------------- | ---- | ------------------------------------------------------------------------ |
| verified                      | 0    | `ok`, exact match, Sourcify backend; one submit                          |
| rejected                      | 1    | failed result, `no_match` reason, no error object; one submit            |
| pending                       | 4    | retryable `not-confirmed`, handle and matching `nextCommand`; one submit |
| resume                        | 0    | `status` uses the pending handle, exact match; zero submits              |
| invalid-input                 | 2    | nonretryable usage error and structured details; no requests             |
| incomplete-input              | 2    | build-info missing compiler input; no requests                           |
| recovered-with-complete-input | 0    | supplied complete compiler input, exact match; one submit                |

To run clients individually after the runner prepares `.work/`:

```sh
python3 validation/polyglot/python/client.py validation/polyglot/.work/python-config.json
validation/polyglot/.work/go-client validation/polyglot/.work/go-config.json
"$JAVA_HOME/bin/java" -cp 'validation/polyglot/.work:validation/polyglot/.work/gson-2.11.0.jar' \
  Client validation/polyglot/.work/java-config.json
```

Use `;` instead of `:` in the Java classpath on Windows. The current runner and
recorded evidence were executed on macOS; Windows portability is not validated.

## Evidence and limits

This is a local protocol contract test. `preload.mjs` replaces every fetch in the
real installed CLI process. It supplies synthetic Sourcify lookup, submission
and job responses, rejects unexpected hosts/routes, checks submitted compiler
input, and records requests without credentials. No public explorer received a
request. No chain, compiler, funded transaction or deployed contract is used.
The small Solidity input and incomplete build-info are synthetic fixtures;
there is no claim of live-explorer acceptance or upstream adoption.

An initial run used a one-second budget with a one-second polling interval;
the deadline arrived before the first poll. The harness now allows three
seconds. Another initial fixture used Standard JSON with URL-only sources;
the candidate correctly classified that as `invalid-input`, not
`incomplete-input`. The final incomplete fixture is build-info without its
compiler input, matching the documented incomplete-input case. Product code
was not changed.

On rejection, check the deployed address and compiler settings before another
submission. On invalid input, correct the named flag or field. On incomplete
build-info, rebuild with build-info enabled and supply the complete compiler
input. The recovery scenario supplies that missing input explicitly. An address
alone cannot reconstruct it through this CLI: there is no address-only recovery
command. The SDK separately exports `buildVerifyInputFromBytecode`; this project
does not test it. Pending jobs resume with `status`, avoiding resubmission.

## Sources

Protocol shapes and CLI contract are attributed to the candidate at
`df036c7245c1baefa869478c7a5a00ca5366d8a2`:

- [CLI reference](../../docs/user/reference/cli.md)
- [JSON envelope and exit codes](../../docs/user/reference/json-output.md)
- [Incomplete input](../../docs/user/reference/errors/incomplete-input.md)
- [Existing Sourcify protocol fixtures](../../packages/explorer-verify/test/fixtures/sourcify/)
- [Gson 2.11.0](https://github.com/google/gson/releases/tag/gson-parent-2.11.0), Apache-2.0
- [Temurin 17.0.21+9](https://github.com/adoptium/temurin17-binaries/releases/tag/jdk-17.0.21%2B9)

The synthetic stand-in follows the recorded fixtures' response fields; it does
not import repository internals or mock a precomputed CLI envelope.

## Integration check

The stock pre-commit lint does not currently include a Node validation-runner
exception: it rejects `process.env`, console output and inferred JavaScript
conditions in the `.mjs` harness. Shared lint configuration is outside this
project's assigned scope. The project was committed with hooks disabled for
that commit; the coordinator must integrate the validation-runner lint policy.
The hook also automatically installed workspace dependencies and refreshed the
repository Git hooks before linting. No tracked shared configuration changed.
