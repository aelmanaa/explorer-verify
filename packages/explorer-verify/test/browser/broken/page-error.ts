// Throws an uncaught error on the page only; the results stay right.
import { inBrowser, startWrapped } from "./wrap.ts";

if (inBrowser) {
  setTimeout(() => {
    throw new Error("smoke: uncaught");
  }, 0);
}
startWrapped((real) => real);
