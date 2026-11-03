// The docsUrl the tests expect for a code, and the repository file it names (decision 0015).

const SITE = "https://aelmanaa.github.io/explorer-verify/";

/** The docsUrl of a code: its page on the docs site. */
export function docsUrlOf(code: string): string {
  return `${SITE}reference/errors/${code}`;
}

/**
 * The repository path of the page a docsUrl names: the site path under `docs/user/`, with `.md`.
 * Undefined for a URL of another form.
 */
export function docsFileOf(docsUrl: string): string | undefined {
  return docsUrl.startsWith(SITE) ? `docs/user/${docsUrl.slice(SITE.length)}.md` : undefined;
}
