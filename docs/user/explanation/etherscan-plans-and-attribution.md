# Etherscan plans and attribution

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and dapp operators who will verify through Etherscan with their own key.

Etherscan's API needs a key, and its API terms set which plan a use needs, how displayed data is
credited, and where a key may live. This page states the rules that shape explorer-verify and how
the library follows them. It is the project's reading of
[Etherscan's API terms](https://etherscan.io/apiterms) ("Last updated: 1 October 2026"), read on
2026-11-02 and again on 2026-11-04. It is not legal advice. For a definitive answer about your
use, ask Etherscan.

In this release explorer-verify has no Etherscan client yet; it comes with
[#61](https://github.com/aelmanaa/explorer-verify/issues/61). Sourcify needs no key and is not
covered by these terms.

## The plan rule

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key.

The terms say:

> The Free, Lite and Standard Plans are licensed for Personal & Research use only.

> The Advanced Plan and higher-tier Plans include Commercial Application use.

Personal and research use includes developing, prototyping and testing an application before it
is deployed commercially. It holds only while the use "does not generate revenue, does not support
a revenue-generating product or service, and is not made on behalf of, or for the benefit of, a
business, organisation or other third party". Commercial Application use covers an application, website, product or service offered
to third parties, free or paid; anything that earns revenue; and anything run by or for a
business, company, protocol, foundation, DAO or other organisation.

| Setup                                                | Plan this reading gives         |
| ---------------------------------------------------- | ------------------------------- |
| A developer verifying their own testnet deployments  | Free, Lite or Standard          |
| A public dapp that verifies its users' deployments   | Advanced or higher, its own key |
| A team or company verifying from CI for its products | Advanced or higher, its own key |

## The attribution rule

When an application displays Etherscan API data, it shows this text:

> Powered by Etherscan.io APIs

The terms add, for every plan:

- It applies "wherever you display, publish or otherwise make available API Data", and to output
  derived from that data.
- The text links to <https://etherscan.io> "where technically practicable".
- "Attribution must be reasonably prominent".
- It "must not suggest that Etherscan sponsors, endorses or is affiliated with your application".
- "Attribution is not required for purely private use that is not displayed or made available to
  any other person".

This project reads a verification status read from Etherscan, such as "verified" shown in a dapp,
as Etherscan API data. A dapp that shows it shows the attribution too.

## Keys stay off the client

The terms forbid sharing or exposing a key, "including by embedding them in publicly accessible
code or client-side applications". So the documented setups of explorer-verify never send an
Etherscan key from a browser ([decision 0003](../../contributor/decisions/0003-etherscan-only-through-a-self-hosted-handler.md)).

- In a backend, a script or CI, pass the key in `apiKeys`; see [API keys](../reference/api-keys.md).
- In a browser, use a keyless backend such as Sourcify, or send Etherscan calls to your own server,
  which adds the key.

## The server handler

`createVerifyHandler` from `explorer-verify/server` keeps the key on your server. The browser
sends its Etherscan requests to the handler, which checks each one, adds the key and forwards it
to Etherscan. [Server handler](../reference/server-handler.md) describes its options and guards.
Its position on the terms (R-SEC-5):

- You run it on your own server, with your own key, as part of your own application.
- It is not offered as a relay to other applications. The project runs no shared relay.
- It forwards only the verify-submit action, `verifysourcecode`, the status action,
  `checkverifystatus`, and a read-only lookup, `getsourcecode`. It reduces the lookup's answer so
  that no source code and no ABI is passed on. With `deployers` set, it also reads the contract's
  creation record from Etherscan, to check who created it.
- The terms forbid operating "an API proxy, gateway, relay or data feed that passes API Data
  through to third parties". Whether a handler limited to these actions counts as such a proxy is
  this project's reading, not legal advice: confirm it with Etherscan before you run it.

A dapp that runs the handler for the public is Commercial Application use, so it needs the Advanced
plan or higher and shows the attribution.

## Sources

- [Etherscan API terms](https://etherscan.io/apiterms), "Last updated: 1 October 2026", read on
  2026-11-02 and 2026-11-04. Every quote on this page comes from it.
- [Etherscan terms research](../../contributor/research/2026-11-02-etherscan-terms.md), the dated
  note behind this page.
