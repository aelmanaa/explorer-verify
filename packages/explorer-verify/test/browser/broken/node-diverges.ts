// Reads an exact match as a partial one, in the Node run only.
import { inBrowser, rewrite, startWrapped } from "./wrap.ts";

startWrapped((real) => async (input, init) => {
  const response = await real(input, init);
  return inBrowser ? response : await rewrite(response, '"exact_match"', '"match"');
});
