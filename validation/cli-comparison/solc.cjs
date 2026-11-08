#!/usr/bin/env node
// Forge invokes the real pinned solc-js compiler through its native solc interface.
const fs = require("node:fs");
const path = require("node:path");
const solc = require(path.join(__dirname, ".work/install/node_modules/solc"));
if (process.argv.includes("--version")) {
  console.log("solc, the solidity compiler commandline interface\nVersion: " + solc.version());
} else if (process.argv.includes("--standard-json")) {
  process.stdout.write(solc.compile(fs.readFileSync(0, "utf8")));
} else {
  throw new Error("Adapter supports only --version and --standard-json");
}
