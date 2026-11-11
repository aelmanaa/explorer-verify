// References: R-FLOW-4, decision 0061.
/**
 * The start of the answer that Etherscan, and the explorers with its API, give to a submit while
 * they have not indexed the contract. The Etherscan-style client waits on it, and `hintFor` reads
 * it in an `unexpected-response` excerpt.
 */
export const NOT_INDEXED_ANSWER = "Unable to locate ContractCode at";
