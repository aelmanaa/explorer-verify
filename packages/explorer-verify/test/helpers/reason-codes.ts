// References: R-FLOW-4, decision 0073.
/**
 * The reason code a `failed` result carries for each definitive Sourcify job error code, as the
 * Sourcify reference documents it. The tests compare the client with this table, written apart
 * from the client's own.
 */
import type { FailureReasonCode } from "../../src/types.ts";

const SOURCIFY_REASON_CODES: Readonly<Record<string, FailureReasonCode>> = {
  no_match: "bytecode-mismatch",
  bytecode_length_mismatch: "bytecode-mismatch",
  compiler_error: "compiler",
  missing_source: "missing-source",
  missing_or_invalid_source: "missing-source",
  invalid_compilation_target: "contract-name",
  contract_not_found_in_compiler_output: "contract-name",
  runtime_bytecode_not_found_in_compiler_output: "contract-name",
  invalid_compiler_version: "compiler",
  unsupported_compiler_version: "compiler",
  invalid_language: "compiler",
  unsupported_language: "compiler",
  compiled_bytecode_is_zero: "contract-name",
  onchain_bytecode_is_zero: "unknown",
  extra_file_input_bug: "missing-source",
};

/**
 * The reason code the table gives `code`.
 *
 * @throws Error for a code the table does not list, so a new definitive code fails the test.
 */
export function sourcifyReasonCode(code: string): FailureReasonCode {
  const found = Object.hasOwn(SOURCIFY_REASON_CODES, code)
    ? SOURCIFY_REASON_CODES[code]
    : undefined;
  if (found === undefined) {
    throw new Error(`No expected reason code for ${code}`);
  }
  return found;
}
