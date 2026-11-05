// A browser page for one test: `globalThis.location`, which a `handlerUrl` path resolves against
// (decision 0046). Node has no `location`, so outside this helper a path is refused.
import type { TestContext } from "node:test";

/** The page URL the helper sets by default. */
export const PAGE_URL = "https://dapp.example/app/";

/**
 * Sets `globalThis.location` to a page at `href` until the test ends.
 *
 * @param t - The test.
 * @param href - The page URL.
 */
export function onPage(t: TestContext, href: string = PAGE_URL): void {
  const before = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    value: { href },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (before === undefined) {
      Reflect.deleteProperty(globalThis, "location");
    } else {
      Object.defineProperty(globalThis, "location", before);
    }
  });
}
