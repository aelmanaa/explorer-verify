import { ExplorerVerifyError, checkStatus } from "explorer-verify";

const PENDING_KEY = "greeter-verification";

/** Polls the job whose handle a previous page load saved, if any. Never submits. */
export async function resumeVerification(show: (line: string) => void): Promise<void> {
  const stored = localStorage.getItem(PENDING_KEY);
  if (stored === null) {
    return;
  }
  show(`Resuming ${stored}`);
  try {
    const result = await checkStatus(stored, { timeoutMs: 60_000 });
    localStorage.removeItem(PENDING_KEY);
    show(result.status);
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
      show("Still checking. The handle stays saved for the next load.");
      return;
    }
    localStorage.removeItem(PENDING_KEY);
    throw error;
  }
}
