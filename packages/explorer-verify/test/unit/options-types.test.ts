// R-IN-6, R-DX-4: the options types as a consumer sees them in the built package, type-checked
// with `strict` and `exactOptionalPropertyTypes`. Every optional input field takes `T | undefined`,
// and each function's options type refuses the fields that function does not read.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createProject, removeProject, typeCheck } from "../helpers/skill.ts";

/** A consumer that forwards `T | undefined` into every optional input field. It must compile. */
const FORWARDS = `
import { buildVerifyInput, checkStatus, dryRun, linkProxy, verify, verifyEach } from "explorer-verify";
import type {
  BackendName,
  BuildVerifyInputOptions,
  CallOptions,
  CheckStatusOptions,
  DryRunOptions,
  Handle,
  Hex,
  LinkProxyOptions,
  LinkProxyTarget,
  Logger,
  RouteOverride,
  SolcCompiler,
  VerifyEachOptions,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  ZksolcCompiler,
} from "explorer-verify";
import { toEnvelope } from "explorer-verify/envelope";
import type { EnvelopeOptions } from "explorer-verify/envelope";
import { buildVerifyInputFromBytecode } from "explorer-verify/resolve";
import type { BuildFromBytecodeOptions } from "explorer-verify/resolve";
import { createVerifyHandler } from "explorer-verify/server";
import type { RateLimit, VerifyHandlerOptions } from "explorer-verify/server";
import type {
  BuildFromProjectOptions as HardhatBuildOptions,
  FindBuildOptions as HardhatFindOptions,
} from "@explorer-verify/hardhat";
import type {
  BuildFromProjectOptions as FoundryBuildOptions,
  FindBuildOptions as FoundryFindOptions,
} from "@explorer-verify/foundry";

declare const env: Readonly<Record<string, string | undefined>>;
declare const maybe: {
  hex: Hex | undefined;
  libraries: Record<string, Hex> | undefined;
  backend: BackendName | undefined;
  fetch: typeof fetch | undefined;
  signal: AbortSignal | undefined;
  number: number | undefined;
  logger: Logger | undefined;
  onEvent: ((event: VerifyEvent) => void) | undefined;
  route: RouteOverride | undefined;
  boolean: boolean | undefined;
  apiKeys: Partial<Record<BackendName, string>> | undefined;
  strings: readonly string[] | undefined;
  sources: Readonly<Record<string, string>> | undefined;
  rateLimit: RateLimit | undefined;
};
declare const base: VerifyInput;
declare const handle: Handle;

const route: RouteOverride = { backend: maybe.backend, apiUrl: env.API_URL, apiKey: env.API_KEY };
const call: CallOptions = {
  fetch: maybe.fetch,
  handlerUrl: env.HANDLER_URL,
  signal: maybe.signal,
  timeoutMs: maybe.number,
  logger: maybe.logger,
  onEvent: maybe.onEvent,
  route: maybe.route,
  allowSourcifyFallback: maybe.boolean,
  apiKeys: maybe.apiKeys,
};
const options: VerifyOptions = { ...call, route, pollIntervalMs: maybe.number, rpcUrl: env.RPC_URL };
const dry: DryRunOptions = { ...call, rpcUrl: env.RPC_URL };
const status: CheckStatusOptions = { ...call, pollIntervalMs: maybe.number };
const link: LinkProxyOptions = { ...call, pollIntervalMs: maybe.number };
const each: VerifyEachOptions = {
  backends: ["sourcify", { backend: "blockscout", apiUrl: env.BLOCKSCOUT, apiKey: env.KEY }],
  fetch: maybe.fetch,
  signal: maybe.signal,
  timeoutMs: maybe.number,
  pollIntervalMs: maybe.number,
  logger: maybe.logger,
  onEvent: maybe.onEvent,
  allowSourcifyFallback: maybe.boolean,
  apiKeys: maybe.apiKeys,
  rpcUrl: env.RPC_URL,
};
const input: VerifyInput = {
  ...base,
  constructorArgs: maybe.hex,
  creationTxHash: maybe.hex,
  creationBytecode: maybe.hex,
  libraries: maybe.libraries,
};
// A zksolc input (decision 0057): solcFork takes string | undefined.
const zksolc: ZksolcCompiler = {
  kind: "zksolc",
  version: "1.5.15",
  solcVersion: "0.8.24+commit.e11b9ed9",
  solcFork: env.FORK,
  input: base.compiler.input,
};
const solc: SolcCompiler = { kind: "solc", version: "0.8.24+commit.e11b9ed9", input: zksolc.input };
const zksolcInput: VerifyInput = { ...input, compiler: zksolc };
const solcInput: VerifyInput = { ...input, compiler: solc };
const target: LinkProxyTarget = { chainId: 1, address: base.address, expectedImplementation: maybe.hex };
const build: BuildVerifyInputOptions = {
  contract: env.CONTRACT,
  compilerVersion: env.VERSION,
  sources: maybe.sources,
};
const resolve: BuildFromBytecodeOptions = {
  bytecode: env.BYTECODE,
  rpcUrl: env.RPC_URL,
  ipfsGateway: env.IPFS,
  allowSourcifyLookup: maybe.boolean,
  sources: maybe.sources,
  fetch: maybe.fetch,
  signal: maybe.signal,
  timeoutMs: maybe.number,
  logger: maybe.logger,
  onEvent: maybe.onEvent,
};
const handler: VerifyHandlerOptions = {
  apiKey: "dummy-key-0001",
  chains: [1],
  deployers: maybe.strings,
  allowProxyLink: maybe.boolean,
  rateLimit: maybe.rateLimit,
  maxBodyBytes: maybe.number,
  timeoutMs: maybe.number,
  fetch: maybe.fetch,
  logger: maybe.logger,
};
const envelope: EnvelopeOptions = { secrets: maybe.strings };
const hardhat: HardhatFindOptions = {
  root: ".",
  contract: "C",
  outDir: env.OUT,
  artifact: env.ARTIFACT,
};
const hardhatBuild: HardhatBuildOptions = {
  ...hardhat,
  compilerVersion: env.VERSION,
  sources: maybe.sources,
};
const foundry: FoundryFindOptions = {
  root: ".",
  contract: "C",
  outDir: env.OUT,
  buildInfoDir: env.BUILD_INFO,
  artifact: env.ARTIFACT,
};

const foundryBuild: FoundryBuildOptions = {
  ...foundry,
  compilerVersion: env.VERSION,
  sources: maybe.sources,
};

export async function run(): Promise<unknown[]> {
  return [
    await verify(input, options),
    await verify(zksolcInput, options),
    await dryRun(solcInput, dry),
    await verify(input, { signal: maybe.signal, timeoutMs: maybe.number, rpcUrl: env.RPC_URL }),
    await dryRun(input, dry),
    await checkStatus(handle, status),
    await linkProxy(target, link),
    // One VerifyOptions value goes to each function: only a literal gets the excess-property check.
    await dryRun(input, options),
    await checkStatus(handle, options),
    await linkProxy(target, options),
    await verifyEach(input, each),
    buildVerifyInput([], build),
    await buildVerifyInputFromBytecode({ chainId: 1, address: base.address }, resolve),
    createVerifyHandler(handler),
    toEnvelope({ status: "failed", backend: "sourcify", reason: "x" }, envelope),
    hardhat,
    hardhatBuild,
    foundry,
    foundryBuild,
  ];
}
`;

/** Each line passes an option the function does not read; each must fail to compile. */
const MISPLACED = [
  'import { checkStatus, dryRun, linkProxy, verify } from "explorer-verify";',
  'import type { Handle, LinkProxyTarget, SolcCompiler, VerifyInput, ZksolcCompiler } from "explorer-verify";',
  "declare const input: VerifyInput;",
  "declare const handle: Handle;",
  "declare const target: LinkProxyTarget;",
  "declare const rpcUrl: string;",
  "export const a = dryRun(input, { pollIntervalMs: 1000 });",
  "export const b = checkStatus(handle, { rpcUrl });",
  "export const c = linkProxy(target, { rpcUrl });",
  "export const d = verify(input, { timeout: 5 });",
  'declare const json: VerifyInput["compiler"]["input"];',
  'export const e: ZksolcCompiler = { kind: "zksolc", version: "1.5.15", input: json };',
  'export const f: SolcCompiler = { kind: "solc", version: "x", solcVersion: "x", input: json };',
  "",
].join("\n");

describe("the options types under exactOptionalPropertyTypes (R-IN-6, R-DX-4)", () => {
  let dir = "";
  before(() => {
    dir = createProject({
      bare: true,
      workspacePackages: {
        "@explorer-verify/hardhat": "hardhat",
        "@explorer-verify/foundry": "foundry",
      },
    });
  });
  after(() => {
    removeProject(dir);
  });

  it("compiles a consumer that forwards T | undefined into every optional input field, and refuses each misplaced option", () => {
    const diagnostics = typeCheck(dir, { "forwards.ts": FORWARDS, "misplaced.ts": MISPLACED });
    // Each line is `<path>/<file>(<line>,<column>): error TS<code>: ...'<property>'...`. The
    // forwarding file has none, and each misplaced option has exactly one.
    const found = diagnostics.map((line) => {
      const match = /(\w+)\.ts\((\d+),\d+\): error (TS\d+): [^']*'(\w+)'/.exec(line);
      return match === null
        ? line
        : `${String(match[1])}:${String(match[2])} ${String(match[3])} ${String(match[4])}`;
    });
    assert.deepEqual(found, [
      "misplaced:7 TS2353 pollIntervalMs",
      "misplaced:8 TS2353 rpcUrl",
      "misplaced:9 TS2353 rpcUrl",
      "misplaced:10 TS2561 timeout",
      "misplaced:12 TS2741 solcVersion",
      "misplaced:13 TS2353 solcVersion",
    ]);
  });
});
