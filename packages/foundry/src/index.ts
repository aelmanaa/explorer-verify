/**
 * Finds a contract's build files in a Foundry project and builds the verification input from
 * them. Node only.
 *
 * It passes the build files to `buildVerifyInput` from `explorer-verify`.
 *
 * @packageDocumentation
 */
export { buildVerifyInputFromFoundry, findFoundryBuild } from "./foundry.ts";
export type { BuildFromProjectOptions, FindBuildOptions, ProjectBuild } from "./foundry.ts";
