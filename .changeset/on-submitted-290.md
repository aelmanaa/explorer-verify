---
"explorer-verify": minor
---

`verify()` and `verifyEach()` take `onSubmitted`. It receives the one-line handle once the
explorer accepts the submission, before the first poll. Keep it to resume the job with
`checkStatus()` after an abort, which rejects with `signal.reason` and carries no handle.

```ts
let handle: string | undefined;
await verify(input, {
  signal: controller.signal,
  onSubmitted: (line) => {
    handle = line;
  },
});
```

- `verifyEach()` calls it once per backend that accepted a submission.
- It is not called when the lookup finds a match or the explorer refuses the submit.
- An exception it throws, or a rejected promise it returns, is logged once at `warn` with keys
  removed. The outcome does not change.
- A value that is not a function throws `invalid-input`.

The abort behaviour does not change. The `verify.submitted` event still carries the handle.

[#290](https://github.com/aelmanaa/explorer-verify/issues/290)
