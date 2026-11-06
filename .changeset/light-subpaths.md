---
"explorer-verify": minor
---

Breaking: `toEnvelope`, `exitCodeOf`, `ERROR_EXIT_CODES` and the types `Envelope`, `EnvelopeOptions`, `ExitCode` and `VerifyOutcome` moved from `explorer-verify` to the new entry `explorer-verify/envelope`. Change `import { toEnvelope } from "explorer-verify"` to `import { toEnvelope } from "explorer-verify/envelope"`. An application that only verifies does not need them.

```ts
// Before
import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify";
import type { Envelope, EnvelopeOptions, ExitCode, VerifyOutcome } from "explorer-verify";

// After
import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import type { Envelope, EnvelopeOptions, ExitCode, VerifyOutcome } from "explorer-verify/envelope";
```

Every other name of `explorer-verify` keeps its import.

Three new entries hold names that a page or a wrapper SDK often imports alone: `explorer-verify/handle` (`formatHandle`, `parseHandle`, `tryParseHandle`, `isHandleString`, `Handle`, `HandleString`), `explorer-verify/errors` (`ExplorerVerifyError`, `ERROR_CODES`, `ERROR_HINTS` and the error types) and `explorer-verify/backends` (`BACKEND_NAMES`, `toBackendName`, `BackendName`, `KeyedBackendName`). None of them reaches the verification code, so every bundler emits one file for a name from them. Under esbuild with `splitting: true`, `formatHandle` from `explorer-verify` loads 13,884 bytes minified and the build emits 21 files; from `explorer-verify/handle` it is one file of 114 bytes. The same names stay on `explorer-verify`.

[#219](https://github.com/aelmanaa/explorer-verify/issues/219)
