// Starts the dapp's server on http://127.0.0.1:8080, or on the port in PORT. The Etherscan key
// comes from the server's environment, ETHERSCAN_API_KEY; without it, the page still deploys and
// verifies on Sourcify. It binds loopback only: see server.ts before you bind another address.
import { createDappServer } from "../server.ts";

const server = createDappServer({ apiKey: process.env.ETHERSCAN_API_KEY ?? "" });
server.listen(Number(process.env.PORT ?? "8080"), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`Serving the dapp at http://127.0.0.1:${String(port)}\n`);
});
