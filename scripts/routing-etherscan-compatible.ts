// The standalone Etherscan-compatible part of the routing table (#170, R-RT-1, decision 0039).
// A standalone explorer serves Etherscan's API on a host of its own, for one chain. The table takes
// these hosts from a keyless probe of the APIs that Foundry's chain list (alloy-chains) names,
// saved as research data. This module reads that data, adds an `etherscan-compatible` entry to
// the rows it names, and compares the table and the data with alloy-chains' live list. It never
// probes an API: a difference with the list asks a person to probe again.
//
// scripts/routing-seed.ts and scripts/compare-routing-table.ts call these functions; the tests
// call them with recorded answers and a fake fetch. This module imports nothing from
// routing-seed.ts, so the two do not form a cycle.

/** The research data of the probe, relative to the repository root. */
export const STANDALONE_FILE =
  "docs/contributor/research/data/2026-11-05-etherscan-compatible-hosts.json";

/** Foundry's chain list, as alloy-chains publishes it. It answers without a key. */
export const ALLOY_CHAINS =
  "https://raw.githubusercontent.com/alloy-rs/chains/main/assets/chains.json";

/** One probed API. */
export interface StandaloneHost {
  readonly chainId: number;
  readonly name: string;
  /** The API's host and path, without the scheme, such as `api.btrscan.com/scan/api`. */
  readonly api: string;
  /** The explorer's host, for the contract page. */
  readonly explorer: string;
}

/** The probe's research data. */
export interface StandaloneProbe {
  /** The probe's date, `YYYY-MM-DD`. */
  readonly checked: string;
  /** The APIs that answered as Etherscan does without a key: the table routes them. */
  readonly hosts: readonly StandaloneHost[];
  /** The APIs that refused a keyless request: no entry until a run with a key. */
  readonly leftOut: readonly StandaloneHost[];
}

/** One chain of alloy-chains' list with an Etherscan-style API. */
export interface AlloyChain {
  readonly chainId: number;
  /** `etherscanApiUrl` without `https://`. */
  readonly api: string;
}

/** One difference, without the list it comes from: always alloy-chains'. */
export interface StandaloneDifference {
  readonly chainId: number;
  readonly text: string;
}

/** The `etherscan-compatible` entry of a `table.json` row. */
export interface StandaloneEntryJson {
  readonly backend: "etherscan-compatible";
  readonly api: string;
  readonly explorer: string;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

function listAt(value: unknown, key: string, what: string): unknown[] {
  const list = field(value, key);
  if (!Array.isArray(list)) {
    throw new Error(`${what}: ${key} must be a list`);
  }
  return list;
}

function textAt(value: unknown, key: string, what: string): string {
  const text = field(value, key);
  if (typeof text !== "string") {
    throw new Error(`${what}: ${key} must be text`);
  }
  return text;
}

function chainIdOf(value: unknown): number | undefined {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Whether `value` is a lowercase host name, as `URL` writes it, with no port, optionally followed
 * by a path with no trailing slash, query or fragment.
 */
export function isApi(value: string): boolean {
  try {
    const url = new URL(`https://${value}`);
    const written = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    return written === value && url.port === "" && !value.endsWith("/");
  } catch {
    return false;
  }
}

function apiAt(value: unknown, key: string, what: string): string {
  const api = textAt(value, key, what);
  if (!isApi(api)) {
    throw new Error(`${what}: ${key} must be a host name and path`);
  }
  return api;
}

function hostAt(value: unknown, key: string, what: string): string {
  const host = apiAt(value, key, what);
  if (host.includes("/")) {
    throw new Error(`${what}: ${key} must be a host name`);
  }
  return host;
}

const byChainId = (a: { chainId: number }, b: { chainId: number }): number => a.chainId - b.chainId;

/**
 * Reads the probe's research data.
 *
 * @param value - The parsed {@link STANDALONE_FILE}.
 * @returns The date, the routed hosts and the hosts left out, each in ascending chain id order.
 * @throws Error naming the field when the data has another shape, a routed host says it needs a
 *   key, or a chain is listed twice.
 */
export function parseStandaloneProbe(value: unknown): StandaloneProbe {
  const what = "standalone probe";
  const hosts = (key: string): StandaloneHost[] =>
    listAt(value, key, what)
      .map((item) => {
        const chainId = chainIdOf(field(item, "chainId"));
        if (chainId === undefined) {
          throw new Error(`${what}: chainId must be a positive integer`);
        }
        return {
          chainId,
          name: textAt(item, "name", what),
          api: apiAt(item, "api", what),
          explorer: hostAt(item, "explorer", what),
        };
      })
      .toSorted(byChainId);
  for (const item of listAt(value, "hosts", what)) {
    if (field(item, "needsKey") !== false) {
      throw new Error(`${what}: a routed host must have needsKey false`);
    }
  }
  const probe = {
    checked: textAt(value, "checked", what),
    hosts: hosts("hosts"),
    leftOut: hosts("leftOut"),
  };
  const ids = [...probe.hosts, ...probe.leftOut].map((host) => host.chainId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${what}: a chain is listed twice`);
  }
  return probe;
}

/**
 * Reads alloy-chains' list.
 *
 * @param value - The parsed body of {@link ALLOY_CHAINS}.
 * @returns Each chain with an `https://` `etherscanApiUrl`, in ascending chain id order.
 * @throws Error naming the field when the answer has another shape.
 */
export function parseAlloyChains(value: unknown): AlloyChain[] {
  const what = "alloy-chains list";
  const chains = field(value, "chains");
  if (typeof chains !== "object" || chains === null || Array.isArray(chains)) {
    throw new Error(`${what}: chains must be an object`);
  }
  const found: AlloyChain[] = [];
  for (const [key, chain] of Object.entries(chains)) {
    const chainId = chainIdOf(key);
    const url = field(chain, "etherscanApiUrl");
    if (chainId === undefined) {
      throw new Error(`${what}: ${key} is not a chain id`);
    }
    if (typeof url === "string" && url.startsWith("https://")) {
      found.push({ chainId, api: url.slice("https://".length) });
    }
  }
  return found.toSorted(byChainId);
}

/**
 * Fetches alloy-chains' list.
 *
 * @param fetch - The fetch to use; the tests pass a fake.
 * @returns The chains with an Etherscan-style API.
 */
export async function fetchAlloyChains(fetch: typeof globalThis.fetch): Promise<AlloyChain[]> {
  const response = await fetch(ALLOY_CHAINS, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new Error(`${ALLOY_CHAINS} answered HTTP ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  return parseAlloyChains(body);
}

/**
 * Adds an `etherscan-compatible` entry, last, to the row of each routed host's chain, and a row
 * with that entry alone for a chain the table has no row for (decision 0039). Call it after
 * `withBlockscout` and before `withRoutescan`, which puts Routescan after it.
 *
 * @param chains - The table's rows, in ascending chain id order.
 * @param probe - The probe's research data.
 * @returns The rows with the standalone entries, in ascending chain id order.
 */
export function withEtherscanCompatible<Entry extends { readonly backend: string }>(
  chains: readonly { readonly chainId: number; readonly backends: readonly Entry[] }[],
  probe: StandaloneProbe,
): { chainId: number; backends: (Entry | StandaloneEntryJson)[] }[] {
  const rows = new Map<number, readonly (Entry | StandaloneEntryJson)[]>(
    chains.map((row) => [row.chainId, row.backends]),
  );
  for (const host of probe.hosts) {
    const backends = rows.get(host.chainId) ?? [];
    if (backends.some((entry) => entry.backend === "etherscan-compatible")) {
      continue;
    }
    const entry: StandaloneEntryJson = {
      backend: "etherscan-compatible",
      api: host.api,
      explorer: host.explorer,
    };
    rows.set(host.chainId, [...backends, entry]);
  }
  return [...rows]
    .map(([chainId, backends]) => ({ chainId, backends: [...backends] }))
    .toSorted(byChainId);
}

/**
 * Every difference between the table's standalone entries, the probe and alloy-chains' live list.
 * Against the probe: a routed host with no `etherscan-compatible` entry, an entry with another API
 * or explorer, and an entry for a chain the probe does not route. Against the live list: a probed
 * chain whose API moved or that left the list. Those ask for a new probe.
 *
 * @param rows - The table's rows: chain id, backend names and the standalone entry's fields.
 * @param probe - The probe's research data.
 * @param live - alloy-chains' chains, as read live.
 * @returns One difference per line, in ascending chain id order within each kind.
 */
export function standaloneDifferences(
  rows: readonly {
    readonly chainId: number;
    readonly backends: readonly string[];
    readonly standalone?: { readonly api?: unknown; readonly explorer?: unknown };
  }[],
  probe: StandaloneProbe,
  live: readonly AlloyChain[],
): StandaloneDifference[] {
  const found: StandaloneDifference[] = [];
  const add = (chainId: number, text: string): void => {
    found.push({ chainId, text });
  };
  const routed = new Set(probe.hosts.map((host) => host.chainId));
  const table = new Map(rows.map((row) => [row.chainId, row]));
  for (const host of probe.hosts) {
    const row = table.get(host.chainId);
    const id = `chain ${String(host.chainId)}`;
    const entry = row?.standalone;
    if (row === undefined || !row.backends.includes("etherscan-compatible")) {
      add(
        host.chainId,
        `table: ${id} has no etherscan-compatible entry; ${host.api} answered on ${probe.checked}`,
      );
    } else if (entry?.api !== host.api || entry.explorer !== host.explorer) {
      add(
        host.chainId,
        `table: ${id} etherscan-compatible entry differs from the probe: ${host.api}, ${host.explorer}`,
      );
    }
  }
  for (const row of rows) {
    if (row.backends.includes("etherscan-compatible") && !routed.has(row.chainId)) {
      add(
        row.chainId,
        `table: chain ${String(row.chainId)} lists etherscan-compatible, which the probe of ${probe.checked} does not route`,
      );
    }
  }
  const listed = new Map(live.map((chain) => [chain.chainId, chain.api]));
  for (const host of [...probe.hosts, ...probe.leftOut].toSorted(byChainId)) {
    const api = listed.get(host.chainId);
    const id = `chain ${String(host.chainId)} (${host.name})`;
    if (api === undefined) {
      add(host.chainId, `alloy-chains: ${id} left the list; probe it`);
    } else if (api !== host.api) {
      add(host.chainId, `alloy-chains: ${id} moved from ${host.api} to ${api}; probe it`);
    }
  }
  return found;
}
