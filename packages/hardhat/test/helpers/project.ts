import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The fixture projects: real output of `hardhat compile` (2.29.1) and `hardhat build` (3.21.2). */
export const HARDHAT_2: string = fileURLToPath(
  new URL("../fixtures/hardhat-2.29.1", import.meta.url),
);
export const HARDHAT_3: string = fileURLToPath(
  new URL("../fixtures/hardhat-3.21.2", import.meta.url),
);

/** The Hardhat 3 build id of the fixture build. */
export const HARDHAT_3_BUILD_ID = "solc-0_8_24-2c15e64bd16481586acae188ce2eaa479a4781e0";
/** The Hardhat 2 build id of the fixture build. */
export const HARDHAT_2_BUILD_ID = "46c2e7c2a379799cbcc7b5723f03d203";

/**
 * Copies a fixture project to a new temporary folder, runs `body` on the copy and removes it, so a
 * test can change files without touching the fixtures.
 */
export async function withCopy(
  fixture: string,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "explorer-verify-hardhat-"));
  try {
    await cp(fixture, root, { recursive: true });
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
