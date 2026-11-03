---
"explorer-verify": patch
---

Redaction now removes a known key that an explorer echoes in a JSON body: JSON-escaped, where a `"` or a `\` in the key is escaped; escaped twice, as in a JSON text inside another; and with each character other than a letter or digit written as `\uXXXX`. A JSON `"apikey"` member is now redacted whole when its value holds up to 1024 escape sequences; before, the part after the first `\` stayed in the text.

[#50](https://github.com/aelmanaa/explorer-verify/issues/50)
