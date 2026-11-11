---
"@explorer-verify/cli": patch
---

`verify` takes `--index-wait <seconds>`: how long to keep sending the submit while the explorer
finds no contract code at the address, as right after a deployment. It sets the library's
`indexWaitMs`.

- It applies to `etherscan-v2`, `routescan` and `etherscan-compatible` only. When every backend
  named on the command line is another one, the run logs one warning.
- `--timeout` caps it. It takes whole seconds from 1 to 2147483, and it may go with
  `--input-json`. A request that holds `indexWaitMs` exits 2 and names `--index-wait`. Any other value exits 2 with `invalid-input` naming `--index-wait`.
- Without it, the CLI sends the submit at most 10 times, as before: about 27 seconds at the
  default `--poll-interval`. A value under about 30 waits less than that.

```sh
explorer-verify verify 0x… --chain sepolia --foundry . --contract src/Greeter.sol:Greeter \
  --backend etherscan-v2 --index-wait 120 --timeout 300
```

The `not-indexed` hint no longer names `--address`, which the CLI does not accept. It names
`--chain` and the address argument, and says to raise `--index-wait` and `--timeout`. Each new
submit now prints one warning line on stderr instead of two.

[#352](https://github.com/aelmanaa/explorer-verify/issues/352)
