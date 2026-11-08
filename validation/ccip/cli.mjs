import { readFile } from "node:fs/promises";

import { verifyCcipBatch, resumeCcip } from "./sdk.mjs";
const [command, file, apiUrl] = process.argv.slice(2);
const url = new URL(apiUrl);
if (url.hostname !== "127.0.0.1")
  throw new Error("Validation CLI only permits loopback explorer endpoints");
const options = {
  route: { backend: "etherscan-compatible", apiUrl },
  timeoutMs: 1500,
  pollIntervalMs: 1000,
};
const input = JSON.parse(await readFile(file, "utf8"));
if (command === "verify") console.log(JSON.stringify(await verifyCcipBatch(input, options)));
else if (command === "resume") console.log(JSON.stringify(await resumeCcip(input.handle, options)));
else throw new Error("Usage: node cli.mjs verify|resume input.json http://127.0.0.1:PORT/api");
