// The Blockscout part of the routing table (#169, R-RT-1, decision 0038). Each Blockscout instance
// serves its own API, so the table takes the instances from a probe of each one, saved as research
// data. This module reads that data, adds a `blockscout` entry to the rows it names, and compares
// the table and the data with Blockscout's live chain registry. It never probes an instance: a
// difference with the registry asks a person to probe again.
//
// scripts/routing-seed.ts and scripts/compare-routing-table.ts call these functions; the tests
// call them with recorded answers and a fake fetch. This module imports nothing from
// routing-seed.ts, so the two do not form a cycle.

/** The research data of the probe, relative to the repository root. */
export const BLOCKSCOUT_FILE =
  "docs/contributor/research/data/2026-11-05-blockscout-instances.json";

/** Blockscout's chain registry. It answers without a key. */
export const BLOCKSCOUT_REGISTRY = "https://chains.blockscout.com/api/chains";

/** Where a probed candidate came from. */
export type BlockscoutSource = "registry" | "hardhat" | "registry-self-hosted";

const SOURCES: readonly BlockscoutSource[] = ["registry", "hardhat", "registry-self-hosted"];

/** One probed candidate instance. */
export interface BlockscoutCandidate {
  readonly chainId: number;
  readonly name: string;
  readonly source: BlockscoutSource;
  /** The host the source lists. */
  readonly listed: string;
  /** The host that answered both probe requests directly, or `undefined` when none did. */
  readonly instance: string | undefined;
}

/** The probe's research data. */
export interface BlockscoutProbe {
  /** The probe's date, `YYYY-MM-DD`. */
  readonly checked: string;
  /** Every probed candidate, in ascending chain id order. */
  readonly candidates: readonly BlockscoutCandidate[];
}

/** One explorer the registry lists as hosted by Blockscout. */
export interface RegistryExplorer {
  readonly chainId: number;
  readonly name: string;
  readonly host: string;
}

/** One difference, without the list it comes from: always the Blockscout registry. */
export interface BlockscoutDifference {
  readonly chainId: number;
  readonly text: string;
}

/** The `blockscout` entry of a `table.json` row. */
export interface BlockscoutEntryJson {
  readonly backend: "blockscout";
  readonly instance: string;
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

function chainIdAt(value: unknown, key: string, what: string): number {
  const id = chainIdOf(field(value, key));
  if (id === undefined) {
    throw new Error(`${what}: ${key} must be a positive integer`);
  }
  return id;
}

/** Whether `value` is a bare lowercase host name, as `URL` writes it, with no port or path. */
function isHost(value: string): boolean {
  try {
    const url = new URL(`https://${value}/`);
    return url.hostname === value && url.href === `https://${value}/`;
  } catch {
    return false;
  }
}

function hostAt(value: unknown, key: string, what: string): string {
  const host = textAt(value, key, what);
  if (!isHost(host)) {
    throw new Error(`${what}: ${key} must be a host name`);
  }
  return host;
}

const byChainId = (a: { chainId: number }, b: { chainId: number }): number => a.chainId - b.chainId;

/**
 * Reads the probe's research data.
 *
 * @param value - The parsed {@link BLOCKSCOUT_FILE}.
 * @returns The date and every candidate, in ascending chain id order.
 * @throws Error naming the field when the data has another shape, an instance is not a bare
 *   lowercase host or `null`, or a chain is listed twice.
 */
export function parseBlockscoutProbe(value: unknown): BlockscoutProbe {
  const what = "Blockscout probe";
  const seen = new Set<number>();
  const candidates = listAt(value, "instances", what).map((item): BlockscoutCandidate => {
    const chainId = chainIdAt(item, "chainId", what);
    if (seen.has(chainId)) {
      throw new Error(`${what}: chain ${String(chainId)} is listed twice`);
    }
    seen.add(chainId);
    const source = SOURCES.find((each) => each === field(item, "source"));
    if (source === undefined) {
      throw new Error(
        `${what}: chain ${String(chainId)} source must be one of ${SOURCES.join(", ")}`,
      );
    }
    const instance = field(item, "instance");
    if (instance !== null && (typeof instance !== "string" || !isHost(instance))) {
      throw new Error(`${what}: chain ${String(chainId)} instance must be a host name or null`);
    }
    return {
      chainId,
      name: textAt(item, "name", what),
      source,
      listed: hostAt(item, "listed", what),
      instance: instance ?? undefined,
    };
  });
  return { checked: textAt(value, "checked", what), candidates: candidates.toSorted(byChainId) };
}

/**
 * The host that answered, per chain, for the candidates with one.
 *
 * @param probe - The probe's research data.
 * @returns The answering host per chain id.
 */
export function blockscoutInstances(probe: BlockscoutProbe): Map<number, string> {
  return new Map(
    probe.candidates.flatMap((candidate): [number, string][] =>
      candidate.instance === undefined ? [] : [[candidate.chainId, candidate.instance]],
    ),
  );
}

/**
 * Reads Blockscout's chain registry: for each chain, the first explorer whose `hostedBy` is
 * `blockscout`, the one Hardhat's verify plugin reads.
 *
 * @param value - The parsed body of {@link BLOCKSCOUT_REGISTRY}: an object keyed by chain id.
 * @returns The explorers, in ascending chain id order.
 * @throws Error naming the field when the answer has another shape.
 */
export function parseBlockscoutRegistry(value: unknown): RegistryExplorer[] {
  const what = "Blockscout registry";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what}: the answer must be an object keyed by chain id`);
  }
  const found: RegistryExplorer[] = [];
  for (const [key, chain] of Object.entries(value)) {
    const chainId = chainIdOf(key);
    if (chainId === undefined) {
      throw new Error(`${what}: ${key} is not a chain id`);
    }
    const explorers = field(chain, "explorers");
    const list: unknown[] = Array.isArray(explorers) ? explorers : [];
    const hosted = list.find((explorer) => {
      const by = field(explorer, "hostedBy");
      return typeof by === "string" && by.toLowerCase() === "blockscout";
    });
    if (hosted === undefined) {
      continue;
    }
    const name = field(chain, "name");
    found.push({
      chainId,
      name: typeof name === "string" ? name : "",
      host: new URL(textAt(hosted, "url", what)).host,
    });
  }
  return found.toSorted(byChainId);
}

/**
 * Fetches Blockscout's chain registry.
 *
 * @param fetch - The fetch to use; the tests pass a fake.
 * @returns The explorers the registry lists as hosted by Blockscout.
 */
export async function fetchBlockscoutRegistry(
  fetch: typeof globalThis.fetch,
): Promise<RegistryExplorer[]> {
  const response = await fetch(BLOCKSCOUT_REGISTRY, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new Error(`${BLOCKSCOUT_REGISTRY} answered HTTP ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  return parseBlockscoutRegistry(body);
}

/**
 * Adds a `blockscout` entry to the row of each chain whose instance answered, and a row with that
 * entry alone for a chain the table has no row for (decision 0038). In a row, the entry goes after
 * the `sourcify` entry; with no `sourcify` entry, after a free-tier `etherscan-v2` entry and before
 * a paid-plan one. Call it before `withRoutescan`, which puts Routescan last (decision 0037).
 *
 * @param chains - The table's rows, in ascending chain id order.
 * @param instances - The answering host per chain id, from {@link blockscoutInstances}.
 * @param paid - The chain ids whose `etherscan-v2` entry needs a paid plan.
 * @returns The rows with the Blockscout entries, in ascending chain id order.
 */
export function withBlockscout<Entry extends { readonly backend: string }>(
  chains: readonly { readonly chainId: number; readonly backends: readonly Entry[] }[],
  instances: ReadonlyMap<number, string>,
  paid: ReadonlySet<number>,
): { chainId: number; backends: (Entry | BlockscoutEntryJson)[] }[] {
  const rows = new Map<number, readonly (Entry | BlockscoutEntryJson)[]>(
    chains.map((row) => [row.chainId, row.backends]),
  );
  for (const [chainId, instance] of instances) {
    const backends = rows.get(chainId) ?? [];
    if (backends.some((entry) => entry.backend === "blockscout")) {
      continue;
    }
    const sourcify = backends.findIndex((entry) => entry.backend === "sourcify");
    const at =
      sourcify !== -1
        ? sourcify + 1
        : backends[0]?.backend === "etherscan-v2" && !paid.has(chainId)
          ? 1
          : 0;
    const entry: BlockscoutEntryJson = { backend: "blockscout", instance };
    rows.set(chainId, [...backends.slice(0, at), entry, ...backends.slice(at)]);
  }
  return [...rows]
    .map(([chainId, backends]) => ({ chainId, backends: [...backends] }))
    .toSorted(byChainId);
}

/**
 * Every difference between the table's Blockscout entries, the probe and Blockscout's live chain
 * registry. Against the probe: an answering instance with no `blockscout` entry or with another
 * host, an entry for a chain with no answering instance, and an entry that does not follow the
 * `sourcify` entry. Against the registry: a chain hosted by Blockscout that the probe did not
 * check, a registry candidate whose host moved, and one the registry no longer lists. Those ask
 * for a new probe.
 *
 * @param rows - The table's rows: chain id, backend names and the `blockscout` entry's instance.
 * @param probe - The probe's research data.
 * @param registry - The registry's explorers hosted by Blockscout, as read live.
 * @returns One difference per line, in ascending chain id order within each kind.
 */
export function blockscoutDifferences(
  rows: readonly {
    readonly chainId: number;
    readonly backends: readonly string[];
    readonly instance?: string;
  }[],
  probe: BlockscoutProbe,
  registry: readonly RegistryExplorer[],
): BlockscoutDifference[] {
  const found: BlockscoutDifference[] = [];
  const add = (chainId: number, text: string): void => {
    found.push({ chainId, text });
  };
  const answered = blockscoutInstances(probe);
  const table = new Map(rows.map((row) => [row.chainId, row]));
  for (const [chainId, instance] of answered) {
    const row = table.get(chainId);
    const id = `chain ${String(chainId)}`;
    const at = row?.backends.indexOf("blockscout") ?? -1;
    if (row === undefined || at === -1) {
      add(
        chainId,
        `table: ${id} has no blockscout entry; ${instance} answered on ${probe.checked}`,
      );
    } else if (row.instance !== instance) {
      add(
        chainId,
        `table: ${id} blockscout instance is ${row.instance ?? "missing"}; the probe says ${instance}`,
      );
    } else {
      const sourcify = row.backends.indexOf("sourcify");
      if (sourcify !== -1 && at !== sourcify + 1) {
        add(chainId, `table: ${id} lists blockscout away from sourcify; it comes right after it`);
      }
    }
  }
  for (const row of rows) {
    if (row.backends.includes("blockscout") && !answered.has(row.chainId)) {
      add(
        row.chainId,
        `table: chain ${String(row.chainId)} lists blockscout, which no instance answered on ${probe.checked}`,
      );
    }
  }
  const probed = new Map(probe.candidates.map((candidate) => [candidate.chainId, candidate]));
  const listed = new Map(registry.map((explorer) => [explorer.chainId, explorer]));
  for (const explorer of registry) {
    const before = probed.get(explorer.chainId);
    const id = `chain ${String(explorer.chainId)} (${explorer.name})`;
    if (before === undefined) {
      add(
        explorer.chainId,
        `blockscout: ${id} is new in the registry at ${explorer.host}; probe it`,
      );
    } else if (before.source === "registry" && before.listed !== explorer.host) {
      add(
        explorer.chainId,
        `blockscout: ${id} moved from ${before.listed} to ${explorer.host} in the registry; probe it`,
      );
    }
  }
  for (const candidate of probe.candidates) {
    if (candidate.source === "registry" && !listed.has(candidate.chainId)) {
      add(
        candidate.chainId,
        `blockscout: chain ${String(candidate.chainId)} (${candidate.name}) left the registry; probe it`,
      );
    }
  }
  return found;
}
