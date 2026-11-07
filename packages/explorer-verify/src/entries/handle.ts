// References: R-FLOW-5, decision 0055.
/**
 * `explorer-verify/handle`: read, write and check the handle of a submitted verification without
 * the verification flow. No module this entry imports reaches the flow
 * or a dynamic `import()`, so a bundler emits one file for any of its names, with or without code
 * splitting. `formatHandle`, `tryParseHandle` and `isHandleString` load none of the error code.
 */
export { formatHandle, isHandleString, parseHandle, tryParseHandle } from "../flow/handle.ts";
export type { Handle, HandleString } from "../types.ts";
