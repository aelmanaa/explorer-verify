/**
 * The chain names `--chain` accepts besides a chain ID (R-AX-12, decision 0056). The routing table
 * holds chain IDs only, so the CLI keeps this list: one short lowercase name for each chain it
 * covers, plus `ethereum` for chain 1. A test checks that the routing table has a row for every
 * ID. A name and its ID give the same run and the same stdout.
 */
import type { InputIssue } from "explorer-verify";

import { closest } from "./suggest.ts";

/**
 * The chain ID of each name, in help order: mainnets, each followed by its testnets and other
 * names for the same chains, such as `op` and `amoy`. Each ID matches the chain's entry on
 * chainid.network (decision 0056).
 */
export const CHAIN_NAMES: ReadonlyMap<string, number> = new Map([
  ["mainnet", 1],
  ["ethereum", 1],
  ["sepolia", 11155111],
  ["holesky", 17000],
  ["hoodi", 560048],
  ["optimism", 10],
  ["optimism-sepolia", 11155420],
  ["op", 10],
  ["op-sepolia", 11155420],
  ["arbitrum", 42161],
  ["arbitrum-nova", 42170],
  ["arbitrum-sepolia", 421614],
  ["base", 8453],
  ["base-sepolia", 84532],
  ["polygon", 137],
  ["polygon-amoy", 80002],
  ["amoy", 80002],
  ["polygon-zkevm", 1101],
  ["bsc", 56],
  ["bsc-testnet", 97],
  ["bnb", 56],
  ["gnosis", 100],
  ["chiado", 10200],
  ["gnosis-chiado", 10200],
  ["avalanche", 43114],
  ["fuji", 43113],
  ["avalanche-fuji", 43113],
  ["linea", 59144],
  ["linea-sepolia", 59141],
  ["scroll", 534352],
  ["scroll-sepolia", 534351],
  ["zksync", 324],
  ["zksync-sepolia", 300],
  ["blast", 81457],
  ["mantle", 5000],
  ["mantle-sepolia", 5003],
  ["celo", 42220],
  ["mode", 34443],
  ["zora", 7777777],
  ["fraxtal", 252],
  ["worldchain", 480],
  ["worldchain-sepolia", 4801],
  ["unichain", 130],
  ["unichain-sepolia", 1301],
  ["ink", 57073],
  ["ink-sepolia", 763373],
  ["sonic", 146],
  ["berachain", 80094],
  ["cronos", 25],
  ["metis", 1088],
  ["sei", 1329],
  ["abstract", 2741],
  ["taiko", 167000],
  ["apechain", 33139],
  ["lisk", 1135],
]);

/** A chain ID: a positive whole number with no leading zero. */
const CHAIN_ID = /^[1-9]\d{0,15}$/;

/** What {@link chainIdOf} found: the chain ID, or the issue and the closest name. */
export type ChainRead =
  | { readonly chainId: number }
  | { readonly issue: InputIssue; readonly suggestion?: string };

/**
 * The chain ID of a `--chain` value: a chain ID, or one of {@link CHAIN_NAMES}, any case. Anything
 * else is an issue that names `--chain`, never the value, with the closest name when one is close
 * (R-AX-9, R-AX-10).
 *
 * @param value - The value of `--chain`.
 * @returns The chain ID, or the issue and the closest name.
 */
export function chainIdOf(value: string): ChainRead {
  if (CHAIN_ID.test(value)) {
    const chainId = Number(value);
    if (Number.isSafeInteger(chainId)) {
      return { chainId };
    }
  }
  const name = value.toLowerCase();
  const chainId = CHAIN_NAMES.get(name);
  if (chainId !== undefined) {
    return { chainId };
  }
  const issue: InputIssue = {
    field: "--chain",
    message:
      "must be a chain ID, such as 11155111, or a chain name the CLI reference lists, such as sepolia",
  };
  const suggestion = closestChain(name);
  return suggestion === undefined ? { issue } : { issue, suggestion };
}

/** A name split at its first `-`: the chain, such as `base`, and the network, such as `sepolia`. */
function parts(name: string): {
  readonly name: string;
  readonly head: string;
  readonly rest: string;
} {
  const at = name.indexOf("-");
  return at === -1
    ? { name, head: name, rest: "" }
    : { name, head: name.slice(0, at), rest: name.slice(at + 1) };
}

/**
 * The closest chain name to a mistyped one, or `undefined`. A suggestion keeps one half of the
 * typed name exactly, so it never moves to another network of another chain: `base-sepolai` gives
 * `base-sepolia` and `optimsm-sepolia` gives `optimism-sepolia`, but a typo in both halves gives
 * nothing. A name without `-` is compared with the names without `-`.
 *
 * @param name - The typed name, in lower case.
 * @returns One of {@link CHAIN_NAMES}, or `undefined`.
 */
export function closestChain(name: string): string | undefined {
  const typed = parts(name);
  const names = [...CHAIN_NAMES.keys()].map(parts);
  const sameRest = names.filter(({ rest }) => rest === typed.rest);
  const head = closest(
    typed.head,
    sameRest.map((each) => each.head),
  );
  if (head !== undefined) {
    return sameRest.find((each) => each.head === head)?.name;
  }
  const sameHead = names.filter((each) => each.head === typed.head && each.rest !== "");
  const rest = closest(
    typed.rest,
    sameHead.map((each) => each.rest),
  );
  return sameHead.find((each) => each.rest === rest)?.name;
}
