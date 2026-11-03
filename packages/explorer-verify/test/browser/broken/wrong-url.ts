// Polls /v2/verify/job/<id> instead of /v2/verify/<id>.
import { startWrapped, urlOf } from "./wrap.ts";

startWrapped((real) => async (input, init) => {
  const url = urlOf(input).replace(/\/v2\/verify\/([0-9a-f-]{36})$/, "/v2/verify/job/$1");
  return await real(url, init);
});
