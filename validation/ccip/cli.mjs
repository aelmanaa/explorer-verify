import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { verifyDeployResults, resumeCcip } from "./sdk.mjs";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "submit-over-partial": { type: "boolean" },
    "index-wait-ms": { type: "string" },
  },
});
const [command, file, apiUrl] = positionals;
const url = new URL(apiUrl);
if (url.hostname !== "127.0.0.1")
  throw new Error("Validation CLI only permits loopback explorer endpoints");
const options = {
  route: { backend: "etherscan-compatible", apiUrl },
  timeoutMs: 1500,
  pollIntervalMs: 1000,
  ...(values["index-wait-ms"] ? { indexWaitMs: Number(values["index-wait-ms"]) } : {}),
  ...(values["submit-over-partial"] ? { submitOverPartial: true } : {}),
};
const input = JSON.parse(await readFile(file, "utf8"));
if (command === "verify") console.log(JSON.stringify(await verifyDeployResults(input, options)));
else if (command === "resume") console.log(JSON.stringify(await resumeCcip(input.handle, options)));
else
  throw new Error(
    "Usage: node cli.mjs verify|resume input.json http://127.0.0.1:PORT/api [--submit-over-partial] [--index-wait-ms N]",
  );
