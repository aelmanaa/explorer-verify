# Flags, help and progress lines that shell users expect

Date: 2026-11-06. Issue: [#225](https://github.com/aelmanaa/explorer-verify/issues/225).

Question: which short flags, help shapes and progress lines do comparable command-line tools use,
and where did `explorer-verify` differ before #225?

## forge verify-contract

From the [forge verify-contract reference](https://getfoundry.sh/forge/reference/forge-verify-contract),
read on 2026-11-06. The page says it is generated from `forge verify-contract --help` and shows no
forge version.

- `-c, --chain`: "The chain name or EIP-155 chain ID", with the environment variable `CHAIN`.
- Other short flags: `-f`, `-e`, `-h`, `-j`, `-r`, `-k`, `-q` and `-v` (`--verbosity`).
- `--delay`: "Optional delay to apply in between verification attempts, in seconds", default 5.

## Command Line Interface Guidelines

From [clig.dev](https://clig.dev/), read on 2026-11-06.

- "Display concise help text by default", when a command that needs arguments runs with none. The
  concise help holds a description, "One or two example invocations", the flags unless there are
  many, and "An instruction to pass the `--help` flag for more information".
- `-n`, `--dry-run`: "Do not run the command, but describe the changes that would occur if the
  command were run."
- `-v`: "This can often mean either verbose or version." The guide does not list `-V`.
- Pagers: "Use a pager (e.g. `less`) if you are outputting a lot of text."
- Progress: "Show progress if something takes a long time", and "If `stdout` is not an interactive
  terminal, don't display any animations."

## cargo

From the [cargo command reference](https://doc.rust-lang.org/cargo/commands/cargo.html), read on
2026-11-06: `-V`, `--version`: "Print version info and exit." `-v` is `--verbose`.

## Chain IDs of the CLI's chain names

From [chainid.network's chain list](https://chainid.network/chains_mini.json), fetched on
2026-11-06. Each name in `packages/cli/src/chains.ts` maps to the ID whose entry has that chain's
name, for example: 10 "OP Mainnet" (`optimism`, `op`), 11155420 "OP Sepolia Testnet"
(`optimism-sepolia`, `op-sepolia`), 80002 "Amoy" (`polygon-amoy`, `amoy`), 43113 "Avalanche Fuji
Testnet" (`fuji`, `avalanche-fuji`), 10200 "Gnosis Chiado Testnet" (`chiado`, `gnosis-chiado`), 56
"BNB Smart Chain Mainnet" (`bsc`, `bnb`) and 300 "zkSync Sepolia Testnet" (`zksync-sepolia`). The
routing table checked on 2026-11-05 has a row for each of these IDs, chain 300 included.

## explorer-verify before #225

Reproduced in [#225](https://github.com/aelmanaa/explorer-verify/issues/225) and in the black-box
run of [#221](https://github.com/aelmanaa/explorer-verify/issues/221), on the built bin with the
CLI test's fake explorer:

- `explorer-verify` with no arguments exited 2 with "command is missing".
- `verify --chain sepolia` exited 2: `--chain` took only a number. `-c`, `-i`, `-n` and `-V` were
  not bound.
- `--contract A --contract B`, `--chain 1 --chain 10` and `--compiler-version` given twice kept
  the last value and exited 0.
- A verify run at the default level printed each fact twice on stderr: the event's line, then
  the core's `info` log line with the same backend.
- `help verify` printed 64 lines, 30 of them the global options, the environment variables and
  the exit codes, which `--help` prints too.
- The help and the CLI reference said `CI` turns "the pager" off. No code read the pager setting.
- An unknown command also reported each option after it by position.
- The spinner always read `Running verify`.
- The routing table holds chain IDs and no chain names (`schemaVersion` 3, checked 2026-11-05).

## Sources

- https://getfoundry.sh/forge/reference/forge-verify-contract, read on 2026-11-06.
- https://clig.dev/, read on 2026-11-06.
- https://doc.rust-lang.org/cargo/commands/cargo.html, read on 2026-11-06.
- https://chainid.network/chains_mini.json, fetched on 2026-11-06.
- https://github.com/aelmanaa/explorer-verify/issues/225 and
  https://github.com/aelmanaa/explorer-verify/issues/221.
