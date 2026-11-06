// R-DX-4, R-IN-6, decision 0052: the types of `explorer-verify/core`, `explorer-verify/clients/*`
// and `explorer-verify/table` as a consumer sees them in the built package, under `strict` and
// `exactOptionalPropertyTypes`. A wrapper SDK that forwards `T | undefined` compiles; a missing
// `clients`, a client of the wrong kind, a hand-built table or a misplaced option does not.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createProject, removeProject, typeCheck } from "../helpers/skill.ts";

/** A wrapper SDK that takes its own options and forwards them. It must compile. */
const WRAPPER = `
import { checkStatus, dryRun, linkProxy, verify, verifyEach } from "explorer-verify/core";
import type {
  ClientList,
  ClientOptions,
  CoreCheckStatusOptions,
  CoreDryRunOptions,
  CoreLinkProxyOptions,
  CoreVerifyEachOptions,
  CoreVerifyOptions,
  ExplorerClient,
  ProxyLinkClient,
  ShippedRoutingTable,
} from "explorer-verify/core";
import { blockscout, blockscoutHosted, blockscoutProxyLink } from "explorer-verify/clients/blockscout";
import { etherscanCompatible, etherscanCompatibleProxyLink } from "explorer-verify/clients/etherscan-compatible";
import { etherscanV2, etherscanV2ProxyLink } from "explorer-verify/clients/etherscan-v2";
import { routescan } from "explorer-verify/clients/routescan";
import { sourcify, sourcifyProxyLink } from "explorer-verify/clients/sourcify";
import { routingTable } from "explorer-verify/table";
import type { BackendName, Handle, LinkProxyTarget, VerifyInput, VerifyResult } from "explorer-verify";

declare const input: VerifyInput;
declare const handle: Handle;
declare const target: LinkProxyTarget;
declare const maybeTable: ShippedRoutingTable | undefined;
declare const maybeTimeout: number | undefined;
declare const useEtherscan: boolean;
// A list built in code, typed as a non-empty list.
export const fromCode: ClientList<ExplorerClient> = useEtherscan ? [sourcify(), etherscanV2()] : [sourcify()];
export const fromCodeResult = verify(input, { clients: fromCode });

const clients: readonly [ExplorerClient, ...ExplorerClient[]] = [
  sourcify(),
  etherscanV2(),
  etherscanCompatible(),
  routescan(),
  blockscout(),
  blockscoutHosted(),
];
const links: readonly [ProxyLinkClient, ...ProxyLinkClient[]] = [
  sourcifyProxyLink(),
  etherscanV2ProxyLink(),
  etherscanCompatibleProxyLink(),
  blockscoutProxyLink(),
];
const backend: BackendName = sourcify().backend;
const linked: readonly BackendName[] = blockscoutProxyLink().backends;
const date: string = routingTable.date;
const kind: "client" = etherscanV2().kind;

export async function verifyToken(): Promise<VerifyResult> {
  const options: CoreVerifyOptions = { clients, table: maybeTable, timeoutMs: maybeTimeout };
  return await verify(input, options);
}
export const forwarded: ClientOptions<ExplorerClient> = { clients: [sourcify()], table: undefined };
export const d = dryRun(input, { clients: [sourcify()] } satisfies CoreDryRunOptions);
export const c = checkStatus(handle, { clients, table: routingTable } satisfies CoreCheckStatusOptions);
export const e = verifyEach(input, {
  clients,
  table: routingTable,
  backends: "all",
} satisfies CoreVerifyEachOptions);
export const l = linkProxy(target, { clients: links, table: routingTable } satisfies CoreLinkProxyOptions);
export { backend, date, kind, linked };
`;

/** Each line misuses the API; each must fail to compile. */
const MISUSE = [
  'import { checkStatus, linkProxy, verify } from "explorer-verify/core";',
  'import { verify as lazyVerify } from "explorer-verify";',
  'import { sourcify, sourcifyProxyLink } from "explorer-verify/clients/sourcify";',
  'import type { Handle, LinkProxyTarget, VerifyInput } from "explorer-verify";',
  "declare const input: VerifyInput;",
  "declare const handle: Handle;",
  "declare const target: LinkProxyTarget;",
  "declare const rpcUrl: string;",
  "export const a = verify(input, {});",
  "export const b = verify(input, { clients: [sourcifyProxyLink()] });",
  "export const c = linkProxy(target, { clients: [sourcify()] });",
  'export const d = verify(input, { clients: [sourcify()], table: { kind: "routing-table" } });',
  "export const e = checkStatus(handle, { clients: [sourcify()], rpcUrl });",
  "export const f = lazyVerify(input, { clients: [sourcify()] });",
  "export const g = verify(input, { clients: [] });",
  "",
].join("\n");

describe("the types of explorer-verify/core and its clients (R-DX-4, R-IN-6, decision 0052)", () => {
  let dir = "";
  before(() => {
    dir = createProject({ bare: true });
  });
  after(() => {
    removeProject(dir);
  });

  it("compiles a wrapper that forwards T | undefined, and refuses each misuse", () => {
    const diagnostics = typeCheck(dir, { "wrapper.ts": WRAPPER, "misuse.ts": MISUSE });
    // Each line is `<path>/<file>(<line>,<column>): error TS<code>: ...`; the wrapper has none.
    // A diagnostic may span more lines; only the first line of each names a file.
    const found = diagnostics.flatMap((line) => {
      const match = /(\w+)\.ts\((\d+),\d+\): error (TS\d+)/.exec(line);
      return match === null ? [] : [`${String(match[1])}:${String(match[2])}`];
    });
    assert.deepEqual(
      [...new Set(found)],
      ["misuse:9", "misuse:10", "misuse:11", "misuse:12", "misuse:13", "misuse:14", "misuse:15"],
      diagnostics.join("\n"),
    );
  });
});
