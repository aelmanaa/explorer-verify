/**
 * The `--version` output (R-AX-11): the CLI's version and the core's, and with `--json` the date
 * of the routing table the core ships, so an agent knows how fresh the chain data is.
 */
import { readFileSync } from "node:fs";

import { routingTableDate } from "explorer-verify";
import corePackage from "explorer-verify/package.json" with { type: "json" };

/** The CLI's package name, as `--version` prints it. */
const CLI_NAME = "@explorer-verify/cli";

/**
 * The version in the text of a `package.json`. It throws when the name or the version is not a
 * non-empty string, so a broken install fails `--version` with `internal-error`, and nothing else.
 *
 * @param text - The file's text.
 * @returns The version.
 * @throws Error when the name or the version is missing or not a string.
 */
export function packageVersion(text: string): string {
  const parsed: unknown = JSON.parse(text);
  const fields = typeof parsed === "object" && parsed !== null ? parsed : {};
  const name: unknown = Reflect.get(fields, "name");
  const version: unknown = Reflect.get(fields, "version");
  if (typeof name !== "string" || name === "" || typeof version !== "string" || version === "") {
    throw new Error(`The package.json of ${CLI_NAME} has no name or no version.`);
  }
  return version;
}

/** The `result` of the version envelope (`version.schema.json`). */
export interface VersionResult {
  /** The version of `@explorer-verify/cli`. */
  readonly cli: string;
  /** The version of the `explorer-verify` core package the CLI runs. */
  readonly core: string;
  /** The date of the core's routing table, as `YYYY-MM-DD`. */
  readonly routingTableDate: string;
}

/**
 * The versions and the routing table's date. The core loads its routing table on demand
 * (decision 0040), so the date comes from a promise.
 *
 * @returns The result of `--version --json`.
 */
export async function versionResult(): Promise<VersionResult> {
  return {
    // Read here, not at load, so only --version depends on the file. The same specifier works
    // from src and dist.
    cli: packageVersion(
      readFileSync(new URL(import.meta.resolve(`${CLI_NAME}/package.json`)), "utf8"),
    ),
    core: corePackage.version,
    routingTableDate: await routingTableDate(),
  };
}

/**
 * The `--version` text: one line per package.
 *
 * @param version - The versions.
 * @returns The text, ending in a newline.
 */
export function versionText(version: VersionResult): string {
  return `${CLI_NAME} ${version.cli}\n${corePackage.name} ${version.core}\n`;
}
