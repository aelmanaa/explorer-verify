---
"@explorer-verify/cli": patch
---

The CLI reads API keys from `ETHERSCAN_API_KEY` and `ROUTESCAN_API_KEY`, from `--api-key-file <path>` or from `--api-key-stdin`, and never from a flag value. `--api-key`, `--apikey`, `--api_key`, `--key`, `--etherscan-api-key`, `--etherscan-key` and `--routescan-api-key` exit 2 with a hint that names the variables and the two key flags, and the value after them is never echoed. A key from a file or stdin needs `--backend etherscan-v2` or `--backend routescan`, whose `apiKeys` entry it fills, or `--api-url` with `--backend` naming one of those or `etherscan-compatible`, which makes it `route.apiKey` for that host. `--api-key-file` reads only a regular file, so a FIFO or a device exits 2 instead of blocking. `--api-key-stdin` exits 2 at once when stdin is a terminal or with `--input-json -`.

`--backend <name>` and `--api-url <url>` set the route. An error about a key names the variable or the flag, never the key, and an error about a key file does not name its path. Every key the CLI read is removed from stdout and stderr in any letter case, at every log level and format.

[#102](https://github.com/aelmanaa/explorer-verify/issues/102)
