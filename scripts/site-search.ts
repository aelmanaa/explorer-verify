// The ranking functions of the docs site's local search (site/.vitepress/config.ts). VitePress
// sends each function to the browser as its source text, so each uses nothing outside its own
// body: no import, no other function of this module, no constant.

/**
 * The search term of a word: lower case, and a plural word as its singular, so "key" also finds
 * "API keys". The index and the query both go through it.
 */
export const processTerm = (term: string): string => {
  const lower = term.toLowerCase();
  return lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")
    ? lower.slice(0, -1)
    : lower;
};

/**
 * The weight of a section in the search results for `term`, a term `processTerm` gave. A section of
 * a page whose title holds `term` as a whole word counts three times, so "etherscan key" lists the
 * API keys page before sections that only mention a key, and "handle" does not lift the server
 * handler page. The title's words go through the same steps as `processTerm`. The generated API
 * reference, under `/api/`, ranks below the pages people write.
 */
export const boostDocument = (
  id: string,
  term: string,
  stored?: Record<string, unknown>,
): number => {
  const titles: unknown = stored?.["titles"];
  const first: unknown = Array.isArray(titles) && titles.length > 0 ? titles[0] : stored?.["title"];
  const words = (typeof first === "string" ? first.toLowerCase() : "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word,
    );
  return (id.includes("/api/") ? 0.5 : 1) * (words.includes(term) ? 3 : 1);
};
