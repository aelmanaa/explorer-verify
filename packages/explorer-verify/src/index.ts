/**
 * Verifies a deployed contract's source on Etherscan, Blockscout, Sourcify or Routescan, and
 * checks the status of a submitted verification.
 *
 * Start with `verify()`, or with `dryRun()` to see where a call would go without submitting.
 *
 * @packageDocumentation
 */
export { BACKEND_LABELS, BACKEND_NAMES, toBackendName } from "./backend-names.ts";
export type { BackendName, KeyedBackendName } from "./backend-names.ts";
export { ERROR_HINTS } from "./error-hints.ts";
export { ERROR_CODES, ExplorerVerifyError } from "./errors.ts";
export { hintFor } from "./user-hints.ts";
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
} from "./errors.ts";
export { formatHandle, isHandleString, parseHandle, tryParseHandle } from "./flow/handle.ts";
export { checkStatus, dryRun, linkProxy, verify, verifyEach } from "./flow/defaults.ts";
export { buildVerifyInput } from "./input/build.ts";
export { routesFor, routingTableDate } from "./routing/load-table.ts";
export type { ChainRoutes, RoutePick, RoutesForOptions } from "./routing/resolve.ts";
export type { BuildVerifyInputOptions, BuiltVerifyInput } from "./input/build.ts";
export { linkLibraries } from "./input/libraries.ts";
export { validateInput } from "./input/validate.ts";
export type {
  ApiKeys,
  BackendEntry,
  BackendOutcome,
  CallOptions,
  CheckStatusOptions,
  DryRunOptions,
  DryRunResult,
  FailureReasonCode,
  Handle,
  HandleString,
  Hex,
  LinkProxyOptions,
  LinkProxyResult,
  LinkProxyTarget,
  LogFields,
  Logger,
  LogValue,
  RoutedBy,
  RouteOverride,
  SolcCompiler,
  SolidityStandardJsonInput,
  StoredContract,
  VerifyEachOptions,
  VerifyEachResult,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
  ZksolcCompiler,
} from "./types.ts";
