---
"explorer-verify": patch
---

`toBackendName()` takes a value of any type and returns `undefined` for a value that is not a string, so a caller no longer checks the type first.
