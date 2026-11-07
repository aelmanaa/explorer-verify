// References: R-IN-7, R-IN-4.
/**
 * The local-path rule shared by the input builder and `validateInput`. Internal:
 * not exported from the package entry point.
 */

// After optional spaces: a Unix or Windows root (`/`, `\`, UNC), a home path (`~`, `~name/`), a
// drive (`C:\`, `C:/` or drive-relative `C:file`) or a file URL, in any case.
const ABSOLUTE_PATH = /^\s*(?:[/\\]|~|[a-z]:|file:)/i;
const SEGMENT_SEPARATOR = /[/\\]/;

/**
 * Whether `path` would publish a location on the build machine: an absolute path, a home path, a
 * drive, a file URL, or a relative path whose `..` segments climb above the project root.
 */
export function isLocalPath(path: string): boolean {
  if (ABSOLUTE_PATH.test(path)) {
    return true;
  }
  let depth = 0;
  for (const segment of path.split(SEGMENT_SEPARATOR)) {
    if (segment === "..") {
      depth--;
      if (depth < 0) {
        return true;
      }
    } else if (segment !== "" && segment !== ".") {
      depth++;
    }
  }
  return false;
}
