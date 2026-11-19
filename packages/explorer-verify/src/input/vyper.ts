// References: R-IN-7, decisions 0075 and 0076.
/**
 * Vyper helpers of the input builder: the release table that completes a version without its
 * 8-character commit, and the rewrite of the source keys that `vyper -f solc_json` writes for a
 * module found in a Python environment. Internal: only `build.ts` imports this module, so the
 * table stays out of the `verify` bundle.
 */
import { isIndexedPath, isLocalPath } from "./paths.ts";

/**
 * The 8-character commit of each stable Vyper release from the supported floor, 0.3.10, by
 * version, as the names of the GitHub release assets give it (`vyper.0.4.3+commit.bff19ea2.linux`,
 * read 2026-11-15). The weekly live check compares it with the GitHub releases API. A release not
 * listed needs `options.compilerVersion`.
 */
export const VYPER_RELEASES: ReadonlyMap<string, string> = new Map([
  ["0.3.10", "91361694"],
  ["0.4.0", "e9db8d9f"],
  ["0.4.1", "8a93dd27"],
  ["0.4.2", "c216787f"],
  ["0.4.3", "bff19ea2"],
]);

// `x.y.z`, or `x.y.z+commit.<7 hex>` as the PyPI wheels print it, with an optional leading `v`.
const PARTIAL_VERSION = /^v?(\d+\.\d+\.\d+)(?:\+commit\.([0-9a-f]{7}))?$/;

/**
 * `version` with the 8-character commit of {@link VYPER_RELEASES} when it is given as `x.y.z` or
 * with a 7-character commit, such as `v0.4.0+commit.e9db8d9`: `0.4.0+commit.e9db8d9f`. `undefined`
 * for a release the table does not list, and `null` when the 7-character commit is not the start
 * of the release's commit. Any other form comes back as it is, for `validateInput` to check.
 */
export function vyperLongVersion(version: string): string | null | undefined {
  const parts = PARTIAL_VERSION.exec(version);
  if (parts === null) {
    return version;
  }
  // Stryker disable next-line StringLiteral: equivalent. The first group always matches, so the default never applies.
  const [, base = "", short] = parts;
  const commit = VYPER_RELEASES.get(base);
  if (commit === undefined) {
    return undefined;
  }
  return short === undefined || commit.startsWith(short) ? `${base}+commit.${commit}` : null;
}

// The part of a path after its last `site-packages` segment: the greedy prefix finds the last one.
const SITE_PACKAGES_KEY = /^(?:.*[/\\])?site-packages[/\\](.+)$/;
// A path that ends with a `site-packages` segment.
const SITE_PACKAGES_DIRECTORY = /(?:^|[/\\])site-packages[/\\]?$/;

/**
 * What a Vyper source key becomes: the part after its last `site-packages` segment, for a module
 * from a Python environment, inside the project (`.venv/lib/…/site-packages/snekmate/…`) or after
 * an index run (`0/1/2/home/user/.venv/…`); else the key itself. `undefined` when the result is an
 * absolute path, climbs above the root, or starts with an index run.
 */
export function rewriteVyperKey(path: string): string | undefined {
  const key = SITE_PACKAGES_KEY.exec(path)?.[1] ?? path;
  return isLocalPath(key) || isIndexedPath(key) ? undefined : key;
}

/**
 * What a `settings.search_paths` entry becomes: `.` for an entry that ends in a `site-packages`
 * directory, the entry itself when it is a relative path inside the project, and `undefined` for
 * any other indexed, absolute or climbing entry.
 */
export function rewriteVyperSearchPath(path: string): string | undefined {
  if (SITE_PACKAGES_DIRECTORY.test(path)) {
    return ".";
  }
  return isLocalPath(path) || isIndexedPath(path) ? undefined : path;
}
