// References: R-DX-3, decision 0055.
/**
 * The error class, its codes, their default hints, `hintFor` and the error types, without the
 * verification flow.
 *
 * No module this entry imports reaches the flow or a dynamic `import()`, so a bundler emits one
 * file for any of its names. `ERROR_CODES` alone loads none of the error class.
 *
 * @packageDocumentation
 */
export { ERROR_HINTS } from "../error-hints.ts";
export { ERROR_CODES, ExplorerVerifyError } from "../errors.ts";
export { hintFor } from "../user-hints.ts";
export type {
  AnyExplorerVerifyError,
  DetailsByCode,
  DetailsJsonOf,
  DetailsOf,
  ErrorCode,
  ErrorDetails,
  ErrorDetailsJson,
  ErrorJson,
  ErrorJsonFields,
  ExplorerVerifyErrorOptions,
  InputIssue,
  MetadataAttempt,
} from "../errors.ts";
