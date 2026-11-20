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

// References: decisions 0075 and 0076.
/**
 * Whether `path` starts with the segment `0`, the index that `vyper -f solc_json` writes for the
 * first `..` of a path, such as `0/1/2/home/user/…`. The path is read with either separator, each
 * segment without surrounding spaces, `.` and empty segments dropped and each `name/..` folded,
 * so `./ ./0/1/x` and `src/../0/1/x` count too.
 */
export function isIndexedPath(path: string): boolean {
  const kept: string[] = [];
  for (const part of path.split(SEGMENT_SEPARATOR)) {
    const segment = part.trim();
    if (segment === ".." && kept.length > 0) {
      kept.pop();
    } else if (segment !== "" && segment !== ".") {
      kept.push(segment);
    }
  }
  return kept[0] === "0";
}
