# Contributing

Thanks for your interest in contributing to **desktop-pet**! Everything is a
plugin here — the runtime, the snapshot state, the chat bridge, the window,
the notifier, and the memory are all ordinary plugins mounted by a small
`PetHost`. Most contributions are either a **new plugin** or a fix to an
existing one.

## Quick orientation

```
src/
  core/        plugin system (host / plugin / schema / config / loader) + Electron-free pet core
  plugins/     built-in plugins: runtime, state, bridge, window, notifier, identity, memory
  entries/     CLI, Electron main, harness-host (mount into a running harness)
  sdk.ts       the single access layer to the vendored SDK client
vendor/        vendored SDK artifacts (see vendor/README.md; refresh with `npm run sync-vendor`)
tests/         unit tests
renderer/      the window's static assets (CSS creature + chat panel + image skin)
```

## Setup

```sh
npm install        # installs electron (binary download) + dev tools
npm run build      # compile to lib/
npm test           # run the test suite
```

## Conventions

- **Plugins are the unit of change.** Add a capability by writing a
  `definePlugin({ name, requires?, config?, setup })` object (see
  `src/plugins/*.ts` and `examples/plugins/`).
- **Electron-free core stays testable.** Anything that touches `electron` is
  lazily imported and the behavior lives in Node-testable modules.
- **Keep the vendored SDK untouched.** `npm run sync-vendor` regenerates it;
  do not hand-edit `vendor/` (except the documented type stubs).
- **Format/style:** the codebase follows the TypeScript strict settings in
  `tsconfig.json` (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noUnusedLocals`, …). Keep it strict.

## Before opening a PR

```sh
npm run typecheck
npm run build
npm test
```

## License

By contributing you agree that your contributions are licensed under the
project's MIT License.
