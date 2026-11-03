/**
 * `@explorer-verify/hardhat`: finds a contract's build files in a Hardhat 2 or Hardhat 3 project
 * and passes them to `buildVerifyInput` from `explorer-verify` (R-DX-2). Node only.
 */
import { buildVerifyInput } from "explorer-verify";
import type { BuiltVerifyInput } from "explorer-verify";

import { findHardhatBuild } from "./find.ts";
import type { FindHardhatBuildOptions } from "./find.ts";

export { findHardhatBuild } from "./find.ts";
export type { FindHardhatBuildOptions, HardhatBuild } from "./find.ts";

/**
 * Builds the `compiler` part of `VerifyInput` and the fully qualified contract name for one
 * contract of a Hardhat 2 or Hardhat 3 project. It calls {@link findHardhatBuild}, then passes the
 * documents to `buildVerifyInput` from `explorer-verify`, which names the contract from the
 * artifact. The result is the same as passing those files to `buildVerifyInput` by hand.
 *
 * @param options - The project root, the contract and, when the config moves it, the artifacts
 *   folder.
 * @returns The compiler part of `VerifyInput` and the contract name, such as
 *   `project/contracts/Greeter.sol:Greeter` on Hardhat 3 or `contracts/Greeter.sol:Greeter` on
 *   Hardhat 2.
 * @throws ExplorerVerifyError what {@link findHardhatBuild} throws, and what `buildVerifyInput`
 *   throws for the documents it was given.
 * @example
 * ```ts
 * import { validateInput, verify } from "explorer-verify";
 * import { verifyInputFromHardhat } from "@explorer-verify/hardhat";
 *
 * const built = await verifyInputFromHardhat({ root: ".", contract: "contracts/Greeter.sol:Greeter" });
 * const input = validateInput({
 *   chainId: 11155111,
 *   address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
 *   ...built,
 * });
 * const result = await verify(input);
 * ```
 * @experimental
 */
export async function verifyInputFromHardhat(
  options: FindHardhatBuildOptions,
): Promise<BuiltVerifyInput> {
  const build = await findHardhatBuild(options);
  return buildVerifyInput(build.documents);
}
