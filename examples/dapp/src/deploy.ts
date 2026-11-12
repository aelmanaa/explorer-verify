import { createPublicClient, createWalletClient, custom, isHex } from "viem";
import type { Abi, EIP1193Provider, Hex } from "viem";
import { sepolia } from "viem/chains";

declare global {
  interface Window {
    /** The provider that most browser wallets inject (EIP-1193). */
    ethereum?: EIP1193Provider;
  }
}

export interface Deployment {
  chainId: number;
  address: Hex;
  creationTxHash: Hex;
}

const CREATION_TX_KEY = "greeter-creation-tx";

function clients() {
  if (window.ethereum === undefined) {
    throw new Error("Install a browser wallet to deploy.");
  }
  const transport = custom(window.ethereum);
  return {
    wallet: createWalletClient({ chain: sepolia, transport }),
    reader: createPublicClient({ chain: sepolia, transport }),
  };
}

/**
 * Loads the ABI and the creation bytecode that the build script wrote in step
 * 1.
 */
async function loadArtifact(): Promise<{ abi: Abi; bytecode: Hex }> {
  const response = await fetch("/contracts/Greeter.deploy.json");
  if (!response.ok) {
    throw new Error(
      `Could not load the contract: HTTP ${String(response.status)}`,
    );
  }
  const artifact: unknown = await response.json();
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("abi" in artifact) ||
    !Array.isArray(artifact.abi) ||
    !("bytecode" in artifact) ||
    !isHex(artifact.bytecode)
  ) {
    throw new Error("Greeter.deploy.json holds no ABI and bytecode.");
  }
  return { abi: artifact.abi, bytecode: artifact.bytecode };
}

/**
 * Waits until the creation transaction is mined, then returns the deployment.
 */
async function waitForDeployment(creationTxHash: Hex): Promise<Deployment> {
  const { reader } = clients();
  const receipt = await reader.waitForTransactionReceipt({
    hash: creationTxHash,
  });
  localStorage.removeItem(CREATION_TX_KEY);
  const address = receipt.contractAddress;
  if (
    receipt.status !== "success" ||
    address === null ||
    address === undefined
  ) {
    throw new Error(`The deployment failed in transaction ${creationTxHash}.`);
  }
  return { chainId: sepolia.id, address, creationTxHash };
}

/**
 * Deploys Greeter from the user's wallet, owned by the user, and waits until it
 * is mined.
 */
export async function deployGreeter(greeting: string): Promise<Deployment> {
  const { wallet } = clients();
  const [account] = await wallet.requestAddresses();
  if (account === undefined) {
    throw new Error("The wallet shared no account.");
  }
  await wallet.switchChain({ id: sepolia.id });
  const artifact = await loadArtifact();

  // The wallet asks the user to confirm. The hash comes back before the
  // transaction is mined.
  const creationTxHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    args: [account, greeting],
  });
  localStorage.setItem(CREATION_TX_KEY, creationTxHash);
  return await waitForDeployment(creationTxHash);
}

/**
 * After a reload: the deployment whose transaction was sent but not yet seen
 * mined, if any.
 */
export async function resumeDeployment(): Promise<Deployment | undefined> {
  const stored = localStorage.getItem(CREATION_TX_KEY);
  return isHex(stored) ? await waitForDeployment(stored) : undefined;
}
