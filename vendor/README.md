# vendor/

Vendored dependencies so this standalone project builds without the
`deepseek-harness` monorepo. All files are MIT-licensed (same license as the
source checkout).

| Directory | Source | Contents |
|---|---|---|
| `dsh-sdk-client/` | `deepseek-harness/packages/sdk/client` (built `lib/`) | `DeepSeekHarness` / `HarnessClient` stdio JSON-RPC client |
| `dsh-sdk-protocol/` | `deepseek-harness/packages/sdk/protocol` (built `lib/`) | newline-delimited JSON-RPC transport + wire types |
| `dsh-llm/` | hand-written stub | `ContentBlock` type |
| `dsh-session/` | hand-written stub | `SessionEvent` type |
| `dsh-subagent/` | hand-written stub | `SubagentStopReason` type |

The two SDK packages are copied from the checkout's **built** `lib/` output
and their external `@deepseek-ai/*` import specifiers are rewritten to
relative paths inside `vendor/`. The three stubs are minimal structural type
definitions covering exactly what the vendored `.d.ts` files reference; the
pet only ever treats those values as opaque records at runtime.

## Refreshing

```sh
npm run sync-vendor              # refresh from DSH_REPO (or ../deepseek-harness)
npm run sync-vendor E:\repo      # refresh from an explicit checkout
npm run sync-vendor:check        # verify the vendored files are up to date
```

Run `sync-vendor` after updating the checkout's SDK packages, then re-run
`npm run build` and `npm test`.

> Note: `scripts/sync-vendor.mjs` is the canonical refresh path. It was used
> to generate this directory from a checkout whose SDK packages report
> version `0.1.0-rc.5`.
