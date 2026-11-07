// References: R-AX-5, R-AX-7, decision 0055.
/**
 * `explorer-verify/envelope`: the machine contract of the CLI:
 * the exit code of an outcome and the versioned JSON envelope the CLI prints. A tool that prints
 * the same envelope or exits with the same codes imports it from here; an application that only
 * verifies does not need it. No module this entry imports reaches the verification flow or a
 * dynamic `import()`.
 */
export { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "../envelope.ts";
export type { Envelope, EnvelopeOptions, ExitCode, VerifyOutcome } from "../envelope.ts";
