# 2026-11-02: Etherscan API terms

Audience: the maintainer and anyone documenting the server handler. Read from
[etherscan.io/apiterms](https://etherscan.io/apiterms) ("Last updated: 1 October 2026") on
2026-11-02. This is a reading of the terms, not legal advice.

## Clauses that shape the design

Prohibited activities:

> Share, disclose or expose your API keys to any third party, including by embedding them in
> publicly accessible code or client-side applications;

> Operate an API proxy, gateway, relay or data feed that passes API Data through to third parties;

Plans:

> The Free, Lite and Standard Plans are licensed for Personal & Research use only.

> The Advanced Plan and higher-tier Plans include Commercial Application use.

"Personal & Research use" includes "developing, prototyping and testing an application before it is
deployed commercially", provided the use "is not made on behalf of, or for the benefit of, a
business, organisation or other third party".

"Commercial Application use" covers any application, website, product or service that "is offered
to third parties, whether free of charge or for a fee", generates revenue, or "is operated by or for
a business, company, protocol, foundation, DAO or other organisation".

Attribution: displays of API data must carry "Powered by Etherscan.io APIs", reasonably prominent,
without implying endorsement.

## What follows for explorer-verify

| Setup                                                                                                                   | Allowed by this reading?                   |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Etherscan key in browser code                                                                                           | No                                         |
| A hosted relay run by this project for many dapps                                                                       | No                                         |
| A dapp operator's own server handler with the operator's own key, verify and status calls only, Advanced plan or higher | Yes, as part of the operator's application |
| The same on a Free, Lite or Standard plan for a public dapp                                                             | No: the dapp is Commercial Application use |
| A developer verifying their own testnet deployments on a Free plan                                                      | Yes: development and testing               |

Open point: whether a narrow verify-only handler is a "proxy ... that passes API Data through to
third parties". The handler returns only the verification status of the user's own deployment, as
part of a broader application. The docs should state this reading and point operators to Etherscan
for a definitive answer.
