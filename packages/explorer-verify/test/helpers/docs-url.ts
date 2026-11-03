// The docsUrl the tests expect for a code, and the repository file it names (decision 0015). The
// site issue (#84) changes the URL here and in src/errors.ts.

const GITHUB_MAIN = "https://github.com/aelmanaa/explorer-verify/blob/main/";

/** The docsUrl of a code. */
export function docsUrlOf(code: string): string {
  return `${GITHUB_MAIN}docs/user/reference/errors/${code}.md`;
}

/** The repository path of the file a docsUrl names, or undefined for a URL of another form. */
export function docsFileOf(docsUrl: string): string | undefined {
  return docsUrl.startsWith(GITHUB_MAIN) ? docsUrl.slice(GITHUB_MAIN.length) : undefined;
}
