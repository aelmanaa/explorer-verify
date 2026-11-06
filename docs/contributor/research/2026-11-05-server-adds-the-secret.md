# How client SDKs let a server add the secret

Date: 2026-11-05. Issue: [#217](https://github.com/aelmanaa/explorer-verify/issues/217).

Question: when a browser must not hold an API secret, how do other client SDKs name the server
that holds it? Do they take a URL, a callback or a `fetch`, and do they keep their own `fetch`
option for other uses?

## What each SDK documents, read on 2026-11-05

| SDK                      | What its documentation says                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel AI SDK, `useChat` | The transport takes `api`, "The API endpoint for chat requests", default `/api/chat`, and a separate `fetch`, "Custom fetch implementation", usable "as a middleware to intercept requests" or "for e.g. testing" ([useChat reference](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)).                         |
| Ably, token auth         | "Give them an `authUrl` or `authCallback`: the SDK then fetches a token from your auth server." Token auth is recommended client side because "Tokens ensure that an Ably API key isn't exposed in client applications" ([Token auth](https://ably.com/docs/auth/token)).                                              |
| Pusher Channels          | `userAuthentication` takes an `endpoint`, default `/pusher/user-auth`, and a `customHandler`; the client libraries "make requests to endpoints of your choice to supply signed authentication and authorization tokens" ([User authentication](https://pusher.com/docs/channels/using_channels/user-authentication/)). |
| OpenAI Node SDK          | A different `fetch` can be passed to the client. Browser use is "disabled by default to avoid exposing your secret API credentials"; enabling it "exposes your secret API credentials in the client-side code" ([openai-node README](https://github.com/openai/openai-node)).                                          |

The Pusher page names the endpoint and the signed token, but does not say that the server signs
with the app secret.

## What it means for explorer-verify

- Three of the four SDKs name the server by a URL option (`api`, `authUrl`, `endpoint`), usually a
  same-origin path, and keep a separate `fetch` or callback for interception and tests. Decision
  0046 does the same: `handlerUrl` names the server, and `fetch` stays a transport hook that does
  not change which requests need a key.
- None of them uses a sentinel value in the secret field to mean "the server has it".
- The OpenAI SDK refuses browser use unless the caller opts in, for the same reason Etherscan's terms
  keep the key out of client code ([2026-11-02-etherscan-terms.md](2026-11-02-etherscan-terms.md)).

## Sources

- Vercel AI SDK, `useChat` reference: https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat (read
  2026-11-05)
- Ably, token authentication: https://ably.com/docs/auth/token (read 2026-11-05)
- Pusher Channels, user authentication:
  https://pusher.com/docs/channels/using_channels/user-authentication/ (read 2026-11-05)
- OpenAI Node SDK README: https://github.com/openai/openai-node (read 2026-11-05)
