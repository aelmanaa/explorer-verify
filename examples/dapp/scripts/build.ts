// Bundles the browser modules for the page: src/main.ts to public/app/main.js, or to the folder
// given as the first argument. Code splitting puts explorer-verify's explorer clients in chunks
// of their own, so the page loads only the client it uses.
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const dapp = new URL("../", import.meta.url);
const outdir = process.argv[2] ?? fileURLToPath(new URL("public/app/", dapp));

await build({
  entryPoints: [fileURLToPath(new URL("src/main.ts", dapp))],
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  logLevel: "warning",
});
process.stdout.write(`Bundled src/main.ts to ${outdir}\n`);
