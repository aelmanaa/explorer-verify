---
"@explorer-verify/cli": patch
"explorer-verify": patch
---

`explorer-verify verify` takes a JSON-RPC endpoint, so it can derive missing constructor arguments from the `--creation-tx` transaction (`VerifyOptions.rpcUrl`). Providers often put a key in the URL, so the CLI treats it like a key. `--rpc-url-file <path>` reads it from a regular file and `--rpc-url-stdin` reads it from stdin, with one trailing newline removed. `--rpc-url <url>` takes only a URL with no path segment, query name or value, user name, password or fragment of 8 or more characters, and exits 2 for any other, such as `https://rpc.ankr.com/eth_sepolia`. Each option can be given once. No environment variable and no `--input-json` field holds the URL; the three options may accompany `--input-json`. `--rpc-url-stdin` exits 2 with `--api-key-stdin` or `--input-json -`, and when stdin is a terminal.

Those parts of the URL, as typed and as parsed, are removed from stdout and stderr in any letter case, at every log level and format, and no error repeats the URL or its file's path. A JSON envelope or JSON log line is scrubbed in its string values and property names, but the envelope's own property names and values that are the CLI's own words, such as backend names and statuses, stay as they are, so the envelope keeps its shape. With `--dry-run`, the URL is checked and gets no request. `input.schema.json` now says that the request has no field for an RPC URL.

[#146](https://github.com/aelmanaa/explorer-verify/issues/146)
