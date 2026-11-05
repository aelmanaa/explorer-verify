# 0035: The answer of an injected fetch is not checked for its origin

Status: Accepted (2026-11-05). Narrows the redirect rule of the HTTP layer added in
[#52](https://github.com/aelmanaa/explorer-verify/pull/52) for R-SEC-2.

Research: [2026-11-05: what a fetch answer says about a redirect](../research/2026-11-05-fetch-redirect-signals.md).

## Context

R-SEC-2 says the library calls only hosts from the routing table or the caller's configuration,
and never follows a redirect. The HTTP layer (`packages/explorer-verify/src/http/fetch.ts`) sends
every request with `redirect: "manual"` and refuses four kinds of answer as a redirect, with
`unexpected-response` and no retry:

1. an opaque redirect, which a browser returns for `redirect: "manual"`;
2. a 3xx status, which Node's fetch returns for `redirect: "manual"`;
3. an answer marked `redirected`;
4. an answer whose `url` has another origin than the request URL.

Checks 3 and 4 were added in #52 for an injected `fetch` that ignores `redirect: "manual"` and
follows the redirect. Check 4 was meant as a second net behind check 3.

Issue [#183](https://github.com/aelmanaa/explorer-verify/issues/183) found that check 4 also
refuses every answer of the server handler. The guide's `handlerFetch` and the dapp tutorial's
`viaHandler` send each Etherscan request to `/api/verify` on the page's origin, or to a Worker on
another origin. With a real `fetch`, the answer's `url` is the handler's URL, never
`api.etherscan.io`, so every answer was taken as a redirect. No test caught it: the fake fetches in
the tests return `new Response(...)`, whose `url` is empty, and check 4 skipped an empty `url`.

What the platform does:

- The Fetch Standard's `manual` redirect mode "Retrieves an opaque-redirect filtered response when
  a request is met with a redirect"; a response's URL "is a pointer to the last URL in response's
  URL list" ([Fetch Standard, requests](https://fetch.spec.whatwg.org/#requests) and
  [response URL](https://fetch.spec.whatwg.org/#concept-response-url), read 2026-11-05).
- `Response.redirected` is "true if the response indicates that your request was redirected", and
  `Response.url` "returns the final URL after redirects"
  ([MDN, Response.redirected](https://developer.mozilla.org/en-US/docs/Web/API/Response/redirected),
  read 2026-11-05).
- On Node 24.21.0 (2026-11-05), the tests in `test/unit/http-fetch-servers.test.ts` show: a 302 or
  307 with `redirect: "manual"` comes back as that status; a fetch that sets `redirect: "follow"`
  and follows a 302 returns an answer with `redirected` true; an answer from a handler on another
  origin has that origin in `url` and `redirected` false.

So for a fetch that follows a redirect through the platform, check 3 already fires. Check 4 adds
nothing there. It adds something only for a fetch that sends the request somewhere else without a
redirect, which is what a proxy or a server handler does on purpose. A wrapper that rebuilds the
answer with `new Response(...)` loses both `redirected` and `url`, so check 4 never caught that
case either.

## Decision

- Checks 1, 2 and 3 apply to every answer, from any `fetch`.
- Check 4 applies only to the platform's fetch: when the caller passes no `fetch`, or passes
  `platformFetch`, the HTTP layer's default that reads `globalThis.fetch` when each request starts.
  That fetch sends the request to the request URL and nowhere else, so an answer from another
  origin there can only be a followed redirect, from a platform or a replaced `globalThis.fetch`
  that ignores `redirect: "manual"`.
- `verify()` and the bytecode resolver used their own copies of the default; they now pass
  `platformFetch`, so their default keeps check 4. `verifyEach()` and `linkProxy()` build their
  requests' context the same way as `verify()`, so each of their requests keeps it too. The server
  handler passes no `fetch` unless its caller sets one, so its upstream requests to Etherscan,
  proxy-link actions included, keep check 4.
- An injected `fetch` chose where the request goes. The library does not check the URL of its
  answer. It still refuses any redirect that `fetch` reports or follows.

## Consequences

- The server handler works from a page: `handlerFetch` to `/api/verify` or to a Worker on another
  origin gets its answer read.
- A `fetch` the caller writes must keep `redirect: "manual"` and must not rebuild an answer it got
  by following a redirect. The docs already say a `fetch` you pass must not follow redirects.
- Tests use real HTTP on 127.0.0.1 with the real global fetch: a handler on another origin answering
  200, a 3xx from the handler, a fetch that follows the handler's redirect, the default fetch
  replaced by one that sends elsewhere, and the Next.js example served over HTTP and called through
  `handlerFetch` by `verify()`.

## Options not taken

| Option                                                                       | For                             | Against                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Drop check 4 for every `fetch`                                               | Simplest code                   | Loses the second net for the default fetch, where another origin can only be a redirect                                      |
| Keep check 4 and let the caller list allowed answer origins                  | Checks the handler's origin too | A new option for a value the caller's `fetch` already chose; a page-relative URL has no origin until the browser resolves it |
| Keep check 4 and tell callers to rebuild the answer with `new Response(...)` | No library change               | Every caller pays for the workaround, and a rebuilt answer also drops `redirected`, which weakens check 3                    |
