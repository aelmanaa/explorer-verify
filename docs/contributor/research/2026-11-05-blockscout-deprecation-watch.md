# 2026-11-05: the baseline of the Blockscout deprecation watch

Audience: whoever reads an issue from the Blockscout deprecation watch
([#198](https://github.com/aelmanaa/explorer-verify/issues/198),
[testing.md](../testing.md#blockscout-deprecation-watch)). Assumes
[the Blockscout instances note](2026-11-05-blockscout-instances.md) and
[the Blockscout client note](2026-11-04-blockscout-client.md).

This note records what the watch compares against: the docs text about the per-instance API, the
headers the instances sent and how many answered, all read on 2026-11-05.

## What Blockscout's docs say

#96 and #198 quote the docs as saying the per-instance API "will be deprecated". On 2026-11-05
the docs say it is deprecated now, still with no removal date:

- [Blockscout APIs](https://docs.blockscout.com/devs/apis), section "Blockscout API Usage": "Our
  Universal Blockscout API is now available, and per-instance API support has been deprecated."
- [Link to Blockscout](https://docs.blockscout.com/devs/replace-links), section "Replace the API
  link": "Per-instance API endpoints (e.g. `eth.blockscout.com/api`) are deprecated. Use the
  Blockscout API instead: one key covers every Blockscout-supported chain." The same section says
  the hosted API "requires a real key on every tier, including the free tier".
- [Blockscout smart contract verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api)
  still sends a self-hosted instance, or a chain the hosted API does not cover, to "that
  instance's own API", and sends Vyper multi-part and Standard JSON verification to "the
  per-instance route".

No page in [the full docs text](https://docs.blockscout.com/llms-full.txt) gave a date for removing
the per-instance API. A search of it for "deprecat", "sunset", "per-instance", "will be removed"
and "will stop" found the three pages above and no date.

Each page has a Markdown form at the same URL with `.md` added. It answered HTTP 200 with
`content-type: text/markdown` and no redirect to Node.js 24.21.0 `fetch` with `redirect: "manual"`. The
HTML form is 542 KB, most of it the site's navigation, so the watch reads the Markdown form.

## The watched sections

The watch hashes the text under each heading up to the next heading, with white space collapsed
(`normalise` in `scripts/blockscout-deprecation.ts`). Read twice on 2026-11-05 at 17:30 UTC, with
the same result both times:

| Page                                                | Heading                   | Characters | SHA-256                                                            |
| --------------------------------------------------- | ------------------------- | ---------: | ------------------------------------------------------------------ |
| `https://docs.blockscout.com/devs/apis.md`          | `## Blockscout API Usage` |       1541 | `c301d04dc59a8815d274716fee9cd2cc95a0067b7d1230b9f10636e61b7fc3be` |
| `https://docs.blockscout.com/devs/replace-links.md` | `## Replace the API link` |       2311 | `4576456715eaeb41cbe0746dcc4052386765ea9eb02d76f74575206cddecf825` |

The texts are in
[data/2026-11-05-blockscout-deprecation-docs.json](data/2026-11-05-blockscout-deprecation-docs.json),
which the script reads. The first section also holds a notice about Blockscout v12.0.0 and links
to other docs pages; a change to either fires the `docs` signal too. That noise is accepted: the
section is short and changes rarely, and a narrower cut could miss a new paragraph with a date.

## What the instances answered

On 2026-11-05 at 17:34 UTC, with Node.js 24.21.0 `fetch`, no key, `redirect: "manual"` and
`accept: application/json`, each of the routing table's 111 Blockscout instances got one
`GET /api?module=block&action=eth_block_number`, one host at a time:

- 110 answered HTTP 200 with a JSON `result` holding a hex block number.
- `worldchain-mainnet.explorer.alchemy.com` (chain 480) answered HTTP 500. Its
  `getsourcecode` answer was HTTP 200 in the probe of the instances note, so this action, not the
  instance, fails there. It is not in the watch's sample.
- No answer had a `Deprecation`, `Sunset` or `Warning` header, or a `Link` header with either
  relation. No body named the hosted API or had deprecation words.

The weekly sample is the 42 instances on `*.blockscout.com` hosts. Run with the script on
2026-11-05 at 17:33 UTC, 500 ms apart: all 42 answered, with no signal. The other 69 are run by
chain teams on their own hosts and versions, so Blockscout cannot switch them off, and they would
pick up a deprecation header later than the hosts Blockscout runs.

`curl` 8.7.1 on `eth.blockscout.com`, `base-sepolia.blockscout.com` and
`camp.cloud.blockscout.com` showed the full header set on 2026-11-05: `access-control-*`,
`bypass-429-option`, `cache-control`, `x-ratelimit-limit` (10), `x-ratelimit-remaining`,
`x-ratelimit-reset`, `x-request-id`, `strict-transport-security` and Cloudflare's headers. None of
them is a deprecation header.

## Sources

- [Blockscout APIs](https://docs.blockscout.com/devs/apis) and its Markdown form
  https://docs.blockscout.com/devs/apis.md, read 2026-11-05.
- [Link to Blockscout](https://docs.blockscout.com/devs/replace-links) and its Markdown form
  https://docs.blockscout.com/devs/replace-links.md, read 2026-11-05.
- [Blockscout smart contract verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api),
  read 2026-11-05.
- [Blockscout docs, full text](https://docs.blockscout.com/llms-full.txt), read 2026-11-05.
- [RFC 9745, the Deprecation HTTP response header field](https://www.rfc-editor.org/rfc/rfc9745)
  and [RFC 8594, the Sunset HTTP header field](https://www.rfc-editor.org/rfc/rfc8594).
- Instance answers: Node.js 24.21.0 `fetch` and `curl` 8.7.1, 2026-11-05, as described above.
