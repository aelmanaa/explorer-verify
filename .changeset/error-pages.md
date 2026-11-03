---
"explorer-verify": patch
---

Each error code now has its own docs page, `docs/reference/errors/<code>.md`, with the cause, the fix, the default hint, whether to retry and the exit code. `error.docsUrl` points at that page, with no fragment, so fetching it returns one code. `docs/reference/errors/index.md` keeps the shared sections: error fields, key redaction, exit codes and retries. `llms.txt` lists every code page.
