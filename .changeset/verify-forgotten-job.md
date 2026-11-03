---
"explorer-verify": patch
---

`verify()` now handles a job the explorer no longer knows as `checkStatus()` does. When a status poll answers `job-not-found`, it looks the contract up once, within the same extra window as the last lookup. A match returns `verified`. Otherwise it throws `job-not-found` with the handle: its hint says to call `verify()` again when the lookup finds the contract not verified, and its `cause` is the lookup's error when the lookup fails. Before, `verify()` threw `job-not-found` at once, so a contract that Routescan verified and then forgot the job of was reported as an error. The call still ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`.

Once the signal aborts, `verify()` and `checkStatus()` now always reject with `signal.reason`, unchanged, including during the forgotten-job lookup. Before, a lookup that threw another error after the abort could make either function reject with that error: `verify()` during any of its lookups, and `checkStatus()` during the forgotten-job lookup. A result reached before the abort is still returned.

[#75](https://github.com/aelmanaa/explorer-verify/issues/75)
