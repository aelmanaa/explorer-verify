// References: decision 0055.
/**
 * `explorer-verify/backends`: the backend names and the check that reads one, without the
 * verification flow. No module this entry imports reaches the flow or a dynamic
 * `import()`, so a bundler emits one file for any of its names.
 */
export { BACKEND_NAMES, toBackendName } from "../backend-names.ts";
export type { BackendName, KeyedBackendName } from "../backend-names.ts";
