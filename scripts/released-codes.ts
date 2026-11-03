// The list of released error codes (R-AX-10, decision 0015), used by
// scripts/record-released-codes.ts and scripts/check-packed-files.ts.
//
// The list is a JSON object that maps each released code to the first version that shipped it, in
// catalogue order. A listed code keeps its page in docs/user/reference/errors/ for good. The
// version step adds the codes of the catalogue that are not listed yet; the release check fails
// while a code of the built package is not listed.
import { PACKAGE_DIR } from "./agent-docs.ts";

/** The list of released codes, relative to the repository root. */
export const RELEASED_CODES: string = `${PACKAGE_DIR}/released-error-codes.json`;
/** The sources entry point of the core package, which exports `ERROR_CODES`. */
export const CORE_SOURCE: string = `${PACKAGE_DIR}/src/index.ts`;

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Released codes and the first version of each, in the order they were added. */
export type Released = Readonly<Record<string, string>>;

/** Parses the list. Throws when it is not an object that maps codes to versions. */
export function parseReleased(text: string): Released {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${RELEASED_CODES} must hold an object that maps each code to a version`);
  }
  const released: Record<string, string> = {};
  for (const [code, version] of Object.entries(parsed)) {
    if (typeof version !== "string" || !VERSION.test(version)) {
      throw new Error(`${RELEASED_CODES}: ${code} has no version`);
    }
    released[code] = version;
  }
  return released;
}

/** The codes of the catalogue that the list lacks, in catalogue order. */
export function unreleasedCodes(released: Released, codes: readonly string[]): string[] {
  return codes.filter((code) => !Object.hasOwn(released, code));
}

/** The list with each missing code of the catalogue added at `version`, in catalogue order. */
export function recordReleased(
  released: Released,
  codes: readonly string[],
  version: string,
): Released {
  const next: Record<string, string> = { ...released };
  for (const code of unreleasedCodes(released, codes)) {
    next[code] = version;
  }
  return next;
}

/** The list as the file holds it: two-space JSON and a final newline. */
export function formatReleased(released: Released): string {
  return `${JSON.stringify(released, null, 2)}\n`;
}
