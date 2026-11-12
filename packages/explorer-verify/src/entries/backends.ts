// References: decision 0055.
/**
 * The backend names, their display labels and the check that reads a name, without the
 * verification flow.
 *
 * No module this entry imports reaches the flow or a dynamic `import()`, so a bundler emits one
 * file for any of its names.
 *
 * @packageDocumentation
 */
export { BACKEND_LABELS, BACKEND_NAMES, toBackendName } from "../backend-names.ts";
export type { BackendName, KeyedBackendName } from "../backend-names.ts";
