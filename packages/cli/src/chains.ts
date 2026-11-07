// References: R-AX-12, decision 0056.
/**
 * The chain names `--chain` accepts besides a chain ID. The routing table
 * holds chain IDs only, so the CLI keeps this list: one short lowercase name for each chain it
 * covers, plus `ethereum` for chain 1. A test checks that the routing table has a row for every
 * ID. A name and its ID give the same run and the same stdout.
 */
import type { InputIssue } from "explorer-verify";

import { closest } from "./suggest.ts";

// References: decision 0056.
/**
 * The chain ID of each name, in help order: mainnets, each followed by its testnets and other
 * names for the same chains, such as `op` and `amoy`. Each ID matches the chain's entry on
 * chainid.network.
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

// References: R-AX-9, R-AX-10.
/**
 * The chain ID of a `--chain` value: a chain ID, or one of {@link CHAIN_NAMES}, any case. Anything
 * else is an issue that names `--chain`, never the value, with the closest name when one is close.
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

/** A name without case, `-`, `_` or spaces, so `op_sepolia`, `opsepolia` and `op-sepolia` match. */
function normal(name: string): string {
  return name.toLowerCase().replaceAll(/[-_\s]/g, "");
}

/** The most two normal forms may differ in length for a suggestion. */
const MAX_LENGTH_GAP = 2;

/**
 * The closest chain name to a mistyped one, or `undefined`. Both sides are compared without case,
 * `-`, `_` or spaces: a name with the same normal form wins, such as `op-sepolia` for `opsepolia`
 * or `base-sepolia` for `base_sepolia`. Otherwise the closest normal form by edit distance wins,
 * among the names whose normal form starts with the same two characters and differs in length by
 * at most 2, so a suggestion never drops the start of the typed name, as `sepolia` for
 * `opsepolia` would.
 *
 * @param name - The typed name.
 * @returns One of {@link CHAIN_NAMES}, or `undefined`.
 */
function closestChain(name: string): string | undefined {
  const typed = normal(name);
  const names = [...CHAIN_NAMES.keys()];
  const same = names.find((each) => normal(each) === typed);
  if (same !== undefined) {
    return same;
  }
  const near = names.filter((each) => {
    const form = normal(each);
    return (
      form.slice(0, 2) === typed.slice(0, 2) &&
      Math.abs(form.length - typed.length) <= MAX_LENGTH_GAP
    );
  });
  const form = closest(
    typed,
    near.map((each) => normal(each)),
  );
  return near.find((each) => normal(each) === form);
}
