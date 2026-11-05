/**
 * `@explorer-verify/hardhat`: finds a contract's build files in a Hardhat 2 or Hardhat 3 project
 * and passes them to `buildVerifyInput` from `explorer-verify` (R-DX-2). Node only.
 */
import { buildVerifyInput } from "explorer-verify";
import type { BuildVerifyInputOptions, BuiltVerifyInput } from "explorer-verify";

import { findHardhatBuild } from "./find.ts";
import type { FindBuildOptions } from "./find.ts";

export { findHardhatBuild } from "./find.ts";
export type { FindBuildOptions, ProjectBuild } from "./find.ts";

/**
 * Options for {@link buildVerifyInputFromHardhat}: where to find the build, as for
 * {@link findHardhatBuild}, and the `compilerVersion` and `sources` options of `buildVerifyInput`.
 *
 * @example
 * ```ts
 * import type { BuildFromProjectOptions } from "@explorer-verify/hardhat";
 *
 * const options: BuildFromProjectOptions = {
 *   root: ".",
 *   contract: "contracts/Greeter.sol:Greeter",
 *   compilerVersion: "0.8.24+commit.e11b9ed9",
 * };
 * ```
 * @experimental
 */
export type BuildFromProjectOptions = FindBuildOptions & Omit<BuildVerifyInputOptions, "contract">;

/**
 * Builds the `compiler` part of `VerifyInput` and the fully qualified contract name for one
 * contract of a Hardhat 2 or Hardhat 3 project. It calls {@link findHardhatBuild}, then passes the
 * documents and the `compilerVersion` and `sources` options to `buildVerifyInput` from
 * `explorer-verify`, which names the contract from the artifact. The result is the same as passing
 * those files to `buildVerifyInput` by hand.
 *
 * @param options - The project root, the contract and, when the config moves it, the output
 *   folder; and the `compilerVersion` and `sources` options of `buildVerifyInput`.
 * @returns The compiler part of `VerifyInput` and the contract name, such as
 *   `project/contracts/Greeter.sol:Greeter` on Hardhat 3 or `contracts/Greeter.sol:Greeter` on
 *   Hardhat 2. Add `chainId` and `address` to get a `VerifyInput`.
 * @throws ExplorerVerifyError what {@link findHardhatBuild} throws, and what `buildVerifyInput`
 *   throws for the documents it was given.
 * @example
 * ```ts
 * import { verify } from "explorer-verify";
 * import { buildVerifyInputFromHardhat } from "@explorer-verify/hardhat";
 *
 * const built = await buildVerifyInputFromHardhat({
 *   root: ".",
 *   contract: "contracts/Greeter.sol:Greeter",
 * });
 * const result = await verify({
 *   chainId: 11155111,
 *   address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
 *   ...built,
 * });
 * ```
 * @experimental
 */
export async function buildVerifyInputFromHardhat(
  options: BuildFromProjectOptions,
): Promise<BuiltVerifyInput> {
  const build = await findHardhatBuild(options);
  const { compilerVersion, sources } = options;
  return buildVerifyInput(build.documents, {
    ...(compilerVersion === undefined ? {} : { compilerVersion }),
    ...(sources === undefined ? {} : { sources }),
  });
}
