---
"explorer-verify": patch
---

Polling now stops at the time budget's deadline when the last wait ends there. Before, a timer that fired on time could read the clock 1 ms early, and `verify()` sent one more status poll. Issue: https://github.com/aelmanaa/explorer-verify/issues/243
