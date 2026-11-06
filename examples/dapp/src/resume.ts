import { ExplorerVerifyError, checkStatus, tryParseHandle } from "explorer-verify";

const PENDING_KEY = "greeter-verification";

/** Polls the job whose handle a previous page load saved, if any. Never submits. */
export async function resumeVerification(show: (line: string) => void): Promise<void> {
  const stored = localStorage.getItem(PENDING_KEY);
  if (stored === null) {
    return;
  }
  // A value that is not a handle, such as one another version of the page wrote, is dropped.
  const handle = tryParseHandle(stored);
  if (handle === undefined) {
    localStorage.removeItem(PENDING_KEY);
    show("The saved handle is not valid. It was removed.");
    return;
  }
  show(`Resuming ${stored}`);
  try {
    const result = await checkStatus(handle, { timeoutMs: 60_000 });
    localStorage.removeItem(PENDING_KEY);
    show(result.status);
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
      show("Still checking. The handle stays saved for the next load.");
      return;
    }
    localStorage.removeItem(PENDING_KEY);
    throw error;
  }
}
