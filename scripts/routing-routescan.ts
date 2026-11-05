// The Routescan part of the routing table (#168, R-RT-1, decision 0037). Routescan's explorer
// list names chains its API does not serve, so the table takes Routescan's chains from a probe of
// the API, saved as research data. This module reads that data, adds a `routescan` entry to the
// rows it names, compares the table and the data with Routescan's live explorer list, and runs the
// probe again for a person who updates the data.
//
// scripts/routing-seed.ts and scripts/compare-routing-table.ts call these functions; the tests
// call them with recorded answers and a fake fetch. This module imports nothing from
// routing-seed.ts, so the two do not form a cycle.

/** Routescan's two networks: the segment of the API path. */
export type RoutescanNetwork = "mainnet" | "testnet";

const NETWORKS: readonly RoutescanNetwork[] = ["mainnet", "testnet"];

/** The research data of the probe, relative to the repository root. */
export const ROUTESCAN_FILE = "docs/contributor/research/data/2026-11-05-routescan-chains.json";

/** Routescan's explorer list of each network. Both answer without a key. */
export const ROUTESCAN_LISTS: Readonly<Record<RoutescanNetwork, string>> = {
  mainnet: "https://api.routescan.io/v2/network/mainnet/evm/all/blockchains",
  testnet: "https://api.routescan.io/v2/network/testnet/evm/all/blockchains",
};

/** The time between two probe requests: Routescan's keyless tier allows 2 requests a second. */
export const PROBE_SPACING_MS = 600;

/**
 * The URL of one probe request: a status request for a job id that does not exist. A chain the API
 * serves answers `Verification not found`; any other chain answers `chain not supported`.
 *
 * @param chain - The chain and its network.
 * @returns The URL.
 */
export function probeUrl(chain: {
  readonly chainId: number | string;
  readonly network: string;
}): string {
  return `https://api.routescan.io/v2/network/${chain.network}/evm/${String(chain.chainId)}/etherscan/api?module=contract&action=checkverifystatus&guid=abc`;
}

/** One chain of Routescan's explorer list or of the probe. */
export interface RoutescanChain {
  readonly chainId: number;
  readonly name: string;
  readonly network: RoutescanNetwork;
}

/** The probe's research data. */
export interface RoutescanProbe {
  /** The probe's date, `YYYY-MM-DD`. */
  readonly checked: string;
  /** The chains whose API answered `Verification not found`: the chains the table routes. */
  readonly served: readonly RoutescanChain[];
  /** The chains of the explorer list whose API answered `chain not supported`. */
  readonly refused: readonly RoutescanChain[];
}

/** One difference, without the list it comes from: always Routescan's. */
export interface RoutescanDifference {
  readonly chainId: number;
  readonly text: string;
}

/** The `routescan` entry of a `table.json` row. */
export interface RoutescanEntryJson {
  readonly backend: "routescan";
  readonly network: RoutescanNetwork;
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

function chainIdAt(value: unknown, key: string, what: string): number {
  const raw = field(value, key);
  const id = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${what}: ${key} must be a positive integer`);
  }
  return id;
}

function networkAt(value: unknown, what: string): RoutescanNetwork {
  const network = NETWORKS.find((each) => each === field(value, "network"));
  if (network === undefined) {
    throw new Error(`${what}: network must be mainnet or testnet`);
  }
  return network;
}

const byChainId = (a: { chainId: number }, b: { chainId: number }): number => a.chainId - b.chainId;

/**
 * Reads the probe's research data.
 *
 * @param value - The parsed {@link ROUTESCAN_FILE}.
 * @returns The date, the served chains and the refused chains, each in ascending chain id order.
 * @throws Error naming the field when the data has another shape.
 */
export function parseRoutescanProbe(value: unknown): RoutescanProbe {
  const what = "Routescan probe";
  const chains = (key: string): RoutescanChain[] =>
    listAt(value, key, what)
      .map((item) => ({
        chainId: chainIdAt(item, "chainId", what),
        name: textAt(item, "name", what),
        network: networkAt(item, what),
      }))
      .toSorted(byChainId);
  return {
    checked: textAt(value, "checked", what),
    served: chains("served"),
    refused: chains("refused"),
  };
}

/**
 * Reads one network's explorer list.
 *
 * @param value - The parsed body of a {@link ROUTESCAN_LISTS} URL.
 * @param network - The list's network.
 * @returns Its chains, by `evmChainId`, in ascending chain id order.
 * @throws Error naming the field when the answer has another shape.
 */
export function parseRoutescanList(value: unknown, network: RoutescanNetwork): RoutescanChain[] {
  const what = `Routescan ${network} list`;
  return listAt(value, "items", what)
    .map((item) => ({
      chainId: chainIdAt(item, "evmChainId", what),
      name: textAt(item, "name", what),
      network,
    }))
    .toSorted(byChainId);
}

async function fetchJson(fetch: typeof globalThis.fetch, url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new Error(`${url} answered HTTP ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  return body;
}

/**
 * Fetches Routescan's explorer lists of both networks.
 *
 * @param fetch - The fetch to use; the tests pass a fake.
 * @returns The chains of both lists, mainnet first.
 */
export async function fetchRoutescanList(
  fetch: typeof globalThis.fetch,
): Promise<RoutescanChain[]> {
  const lists = await Promise.all(
    NETWORKS.map(async (network) =>
      parseRoutescanList(await fetchJson(fetch, ROUTESCAN_LISTS[network]), network),
    ),
  );
  return lists.flat();
}

/**
 * Adds a `routescan` entry, last, to the row of each chain the probe found served, and a row with
 * that entry alone for a served chain the table has no row for (decision 0037).
 *
 * @param chains - The table's rows, in ascending chain id order.
 * @param probe - The probe's research data.
 * @returns The rows with the Routescan entries, in ascending chain id order.
 */
export function withRoutescan<Entry>(
  chains: readonly { readonly chainId: number; readonly backends: readonly Entry[] }[],
  probe: RoutescanProbe,
): { chainId: number; backends: (Entry | RoutescanEntryJson)[] }[] {
  const served = new Map(probe.served.map((chain) => [chain.chainId, chain.network]));
  const entry = (chainId: number): RoutescanEntryJson[] => {
    const network = served.get(chainId);
    return network === undefined ? [] : [{ backend: "routescan", network }];
  };
  const listed = new Set(chains.map((row) => row.chainId));
  return [
    ...chains.map((row) => ({
      chainId: row.chainId,
      backends: [...row.backends, ...entry(row.chainId)],
    })),
    ...probe.served
      .filter((chain) => !listed.has(chain.chainId))
      .map((chain) => ({ chainId: chain.chainId, backends: entry(chain.chainId) })),
  ].toSorted(byChainId);
}

/**
 * Every difference between the table's Routescan entries, the probe and Routescan's live explorer
 * list. Against the probe: a served chain with no `routescan` entry, an entry on another network
 * or before another backend, and an entry for a chain the probe did not find served. Against the
 * live list: a chain the probe did not check, a chain on another network, and a served chain the
 * list no longer names. The last two kinds ask for a new probe.
 *
 * @param rows - The table's rows: chain id, backend names and the `routescan` entry's network.
 * @param probe - The probe's research data.
 * @param live - Routescan's explorer lists, as read live.
 * @returns One difference per line, in ascending chain id order within each kind.
 */
export function routescanDifferences(
  rows: readonly {
    readonly chainId: number;
    readonly backends: readonly string[];
    readonly network?: string;
  }[],
  probe: RoutescanProbe,
  live: readonly RoutescanChain[],
): RoutescanDifference[] {
  const found: RoutescanDifference[] = [];
  const add = (chainId: number, text: string): void => {
    found.push({ chainId, text });
  };
  const served = new Map(probe.served.map((chain) => [chain.chainId, chain]));
  const table = new Map(rows.map((row) => [row.chainId, row]));
  for (const chain of probe.served) {
    const row = table.get(chain.chainId);
    const id = `chain ${String(chain.chainId)}`;
    const at = row?.backends.indexOf("routescan") ?? -1;
    if (row === undefined || at === -1) {
      add(
        chain.chainId,
        `table: ${id} has no routescan entry; Routescan's API served it on ${probe.checked}`,
      );
    } else if (row.network !== chain.network) {
      add(
        chain.chainId,
        `table: ${id} routescan network is ${row.network ?? "missing"}; the probe says ${chain.network}`,
      );
    } else if (at !== row.backends.length - 1) {
      add(chain.chainId, `table: ${id} lists routescan before another backend; it comes last`);
    }
  }
  for (const row of rows) {
    if (row.backends.includes("routescan") && !served.has(row.chainId)) {
      add(
        row.chainId,
        `table: chain ${String(row.chainId)} lists routescan, which the probe of ${probe.checked} did not find served`,
      );
    }
  }
  const probed = new Map(
    [...probe.served, ...probe.refused].map((chain) => [chain.chainId, chain]),
  );
  const named = new Set(live.map((chain) => chain.chainId));
  for (const chain of live) {
    const before = probed.get(chain.chainId);
    const id = `chain ${String(chain.chainId)} (${chain.name})`;
    if (before === undefined) {
      add(chain.chainId, `routescan: ${id} is new in the ${chain.network} list; probe its API`);
    } else if (before.network !== chain.network) {
      add(
        chain.chainId,
        `routescan: ${id} moved from the ${before.network} list to the ${chain.network} list; probe its API`,
      );
    }
  }
  for (const chain of probe.served) {
    if (!named.has(chain.chainId)) {
      add(
        chain.chainId,
        `routescan: chain ${String(chain.chainId)} (${chain.name}) left the ${chain.network} list; probe its API`,
      );
    }
  }
  return found;
}

/**
 * Probes Routescan's API for each chain of its explorer lists: one keyless {@link probeUrl}
 * request each, {@link PROBE_SPACING_MS} apart.
 *
 * @param fetch - The fetch to use; the tests pass a fake.
 * @param wait - Waits the given milliseconds; the tests pass one that returns at once.
 * @param checked - The probe's date, `YYYY-MM-DD`.
 * @returns The research data: the chains the API serves and the chains it refuses.
 * @throws Error on an answer that is neither `Verification not found` nor `chain not supported`.
 */
export async function probeRoutescan(
  fetch: typeof globalThis.fetch,
  wait: (ms: number) => Promise<void>,
  checked: string,
): Promise<RoutescanProbe> {
  const served: RoutescanChain[] = [];
  const refused: RoutescanChain[] = [];
  let first = true;
  for (const chain of await fetchRoutescanList(fetch)) {
    if (!first) {
      await wait(PROBE_SPACING_MS);
    }
    first = false;
    const url = probeUrl(chain);
    const answer = await fetchJson(fetch, url);
    if (field(answer, "result") === "Verification not found") {
      served.push(chain);
    } else if (field(answer, "message") === "chain not supported") {
      refused.push(chain);
    } else {
      throw new Error(`${url} gave an answer that is neither served nor refused`);
    }
  }
  return { checked, served: served.toSorted(byChainId), refused: refused.toSorted(byChainId) };
}

/**
 * The research data file for a probe, as {@link ROUTESCAN_FILE} holds it.
 *
 * @param probe - The probe's result.
 * @returns The JSON object to save, with a comment, the request and the two lists.
 */
export function routescanData(probe: RoutescanProbe): Record<string, unknown> {
  return {
    $comment: `Research data behind the Routescan entries of the routing table (decision 0037). It does not ship. On ${probe.checked}, each chain of Routescan's two explorer lists was sent one keyless request, the one in request, on its listed network. served holds the chains that answered Verification not found; refused holds the chains that answered chain not supported. scripts/routing-seed.ts reads it, and node scripts/compare-routing-table.ts --probe-routescan prints a new copy.`,
    checked: probe.checked,
    request: `GET ${probeUrl({ chainId: "<chain id>", network: "<network>" })}`,
    served: probe.served,
    refused: probe.refused,
  };
}
