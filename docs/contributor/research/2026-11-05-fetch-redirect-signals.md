# What a fetch answer says about a redirect

Date: 2026-11-05. Issue: [#183](https://github.com/aelmanaa/explorer-verify/issues/183).

Question: which fields of a `fetch` answer show that a redirect was met or followed, and what does
`Response.url` hold when a `fetch` sends the request to another URL on purpose, such as a server
handler?

## Specifications and documentation, read on 2026-11-05

| Source         | What it says                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fetch Standard | Redirect mode `manual` "Retrieves an opaque-redirect filtered response when a request is met with a redirect". A response's URL "is a pointer to the last URL in response's URL list".                |
| MDN            | `Response.redirected` is "true if the response indicates that your request was redirected". `Response.url` "returns the final URL after redirects". It recommends `redirect: "error"` to prevent one. |

## Checked locally on 2026-11-05

Node 24.21.0, the global `fetch`, servers from `node:http` on 127.0.0.1. The tests are in
`packages/explorer-verify/test/unit/http-fetch-servers.test.ts` and
`examples/test/nextjs-http.test.ts`.

| Case                                                                     | What the answer held                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 301, 302, 303, 307 or 308 with `redirect: "manual"`                      | That status; the `Location` target got no request                                    |
| A `fetch` that sets `redirect: "follow"` and meets a 302                 | The target's 200, with `redirected` true                                             |
| A `fetch` that sends an Etherscan request to a handler on another origin | The handler's 200, with `redirected` false and the handler's origin in `url`         |
| `new Response(...)`                                                      | An empty `url` and `redirected` false, whatever the `fetch` that built it did before |

## What it means for the HTTP layer

- A followed redirect shows in `redirected`, whatever URL the request was sent to.
- An answer whose `url` has another origin than the request URL shows only that the `fetch` sent
  the request somewhere else. For the platform's fetch, given the request URL, that is a followed
  redirect. For a `fetch` the caller wrote, it may be a server handler or a proxy.
- A `fetch` that rebuilds its answer with `new Response(...)` hides both signals.

## Sources

- Fetch Standard, requests (redirect mode): https://fetch.spec.whatwg.org/#requests (read
  2026-11-05)
- Fetch Standard, response URL: https://fetch.spec.whatwg.org/#concept-response-url (read
  2026-11-05)
- MDN, `Response.redirected`: https://developer.mozilla.org/en-US/docs/Web/API/Response/redirected
  (read 2026-11-05)
- Node.js 24.21.0 global `fetch`, run locally on 2026-11-05 by the tests named above
