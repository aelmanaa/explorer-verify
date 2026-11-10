// References: R-AX-5, R-AX-7, decision 0055.
/**
 * The exit code of an outcome and the versioned JSON envelope that the CLI prints.
 *
 * A tool that prints the same envelope or exits with the same codes imports them from here; an
 * application that only verifies does not need them. No module this entry imports reaches the
 * verification flow or a dynamic `import()`.
 *
 * @packageDocumentation
 */
export { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "../envelope.ts";
export type { Envelope, EnvelopeOptions, ExitCode, VerifyOutcome } from "../envelope.ts";
