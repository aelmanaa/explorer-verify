---
"explorer-verify": patch
---

A `Retry-After` date in the asctime form, such as `Sun Nov  6 08:49:37 1994`, is now read as UTC, as RFC 9110 requires, and no longer as the machine's local time.
