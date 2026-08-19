# desktop-pet — a DeepSeek Harness desktop pet

A standalone desktop pet for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): an Electron transparent, frameless, always-on-top window floats a small creature that mirrors one agent session's activity — idle / thinking / acting (with the running tool) / speaking (streaming text in a speech bubble) / error — and double-clicking it opens a chat panel to talk to the agent. **Everything is a plugin**: the runtime, the snapshot state, the chat bridge, the window, notifications, identity, and long-term memory are all plain plugins mounted on one small `PetHost`.

Extracted from `deepseek-harness/packages/extensions/desktop-pet`, this project:

- no longer depends on the monorepo — the SDK client's built artifacts are vendored into `vendor/` (see `vendor/README.md`), so `npm install` only fetches `electron`;
- replaces the "package root doubles as a Cordis plugin" coupling with a small plugin system (`PetHost` + `definePlugin`); external plugins auto-load from a `plugins/` directory or the config file;
- keeps two ways to talk to DSH: standalone (the SDK client drives its own `dsh-jsonrpc-agent` runtime) and harness-host (mounted as a `cordis.yml` row inside a running harness).

## Requirements

- **Node.js ≥ 22.19**;
- a **DeepSeek Harness runtime**: `dsh-jsonrpc-agent` on `PATH` by default (from an installed deepseek-harness), or any SDK-compatible runtime via `DSH_PET_RUNTIME` / config;
- **credentials**: `DEEPSEEK_API_KEY`, or an already-configured harness credential store (`~/.dsh/.credentials.yaml`) — the pet injects the key automatically, no separate config needed.

## Quick start

```sh
npm install                 # installs electron (+ binary) and dev tools
npm run build               # compile to lib/
npm test                    # run the test suite

npm start                   # launch the pet window (electron lib/entries/window.js)
npm run pet                 # same, via the CLI (node lib/entries/cli.js)
```

The pet is draggable; double-click toggles the chat panel; the panel's × collapses it (quit via the tray menu). All chats share one session id (`desktop-pet`); context persists within the window.

**Summon the pet anytime**:

- **system tray** (next to the clock): click the icon to summon + expand the chat; right-click for "show / quit" (`window.tray: false` to disable);
- **global hotkey**: `Ctrl+Shift+P` (`window.hotkey`, empty string disables);
- if it isn't running: `npm start`, or `start-pet.bat` / `restart-pet.bat` on Windows.

**Replies stream**: `assistant/chunk` `text-delta` fragments are accumulated live into the bubble.

## Configuration

Config file: `./desktop-pet.config.json` (or `DSH_PET_CONFIG` / `--config`; `.js/.mjs/.cjs` modules are also supported). See `desktop-pet.config.example.json`.

```jsonc
{
  "name": "小蓝",                                  // the pet's name (top-level)
  "defaults": { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
  "plugins": {
    "runtime": { "command": "dsh-jsonrpc-agent", "args": [] },
    "bridge":  { "sessionId": "desktop-pet" },
    "memory":  { "dir": "data" },
    "window":  { "alwaysOnTop": true, "hotkey": "CommandOrControl+Shift+P" },
    "notifier": { "notifyPort": 17890 }
  },
  "pluginDirs": ["plugins"]
}
```

Environment overrides (the original extension's contract): `DSH_PET_RUNTIME`, `DSH_PET_RUNTIME_ARGS`, `DSH_PET_CWD`, `DSH_PET_PROVIDER`, `DSH_PET_MODEL`.

### Credentials — no separate key needed

The pet never assembles a provider request itself; the model experience is owned by the runtime it launches. The `runtime` plugin builds the child environment and, when `DEEPSEEK_API_KEY` is absent, injects the key from `$DSH_HOME/.credentials.yaml` (`~/.dsh/.credentials.yaml`).

## Everything is a plugin

```ts
interface PetPlugin<TConfig extends object = object> {
  name: string
  version?: string
  description?: string
  requires?: string[]      // must start before this plugin
  optional?: string[]
  config?: Schema<TConfig> // options validation (see core/schema.ts)
  setup(ctx: PluginContext<TConfig>, config: TConfig): Disposer | Promise<Disposer>
}
```

`PetHost` topologically orders plugins by their `requires`/`optional` edges, runs `setup` in order, and runs disposers in reverse. `PluginContext` exposes `on`/`emit` (events), `get`/`provide` (services), `config`, `logger`, and `host.dispose()`.

Built-in plugins: `runtime` (harness subprocess), `state` (snapshot), `bridge` (chat + `turn:done`/`approval:asked` events), `window` (Electron + tray + hotkey), `notifier` (desktop notifications + approval cards + local HTTP endpoint), `identity` (name), `memory` (persona + facts + episodes + history).

### Write an external plugin

Drop a file into `plugins/`:

```js
// plugins/snapshot-logger.mjs
export default {
  name: 'snapshot-logger',
  description: 'Logs every mood change',
  setup(ctx) {
    return ctx.on('snapshot', (snapshot) => ctx.logger.info(`mood -> ${snapshot.mood}`))
  },
}
```

## Long-term memory & persona

The `memory` plugin persists to `data/` (gitignored):

- `data/persona.md` — the pet's personality (edit to reshape it);
- `data/memory.json` — `facts` (about the user), `episodes` (distilled summaries), `history` (working memory).

Injected into the first prompt of every launch. Chat commands: "记住：X" (remember a fact), "忘了：X" (forget), "你记得什么" (recall). Overflowing history is consolidated into episodes in the background.

## Desktop notifications & approvals

`notifier` pops a system notification on task completion (only while the window is unfocused, by default) and on approval requests, and exposes a local endpoint (`http://127.0.0.1:17890`) so any process — including a harness host — can push `{ title, body, jumpUrl }`. Clicking a notification focuses the pet or opens `jumpUrl`.

Mount the pet in a DeepSeek Harness host to forward the host's approvals/task-completion to the pet (and optionally let the pet answer approvals):

```yaml
- id: desktop-pet
  name: 'desktop-pet/harness-host'
  config:
    notifyUrl: 'http://127.0.0.1:17890'
    webBaseUrl: 'http://127.0.0.1:8090'
    sessionPath: '/#/session/{sessionId}'
    answerApprovals: true
```

## Changing the pet's look

Drop an image into `renderer/` and restart:

- `pet.png` — the default skin (all moods);
- `pet-idle.png` / `pet-thinking.png` / `pet-acting.png` / `pet-speaking.png` / `pet-error.png` — per-mood skins (optional; missing moods fall back to `pet.png`).

Transparent PNGs ~132×128 work best. Without any image the built-in CSS creature is used. The window/tray icon accepts `window.icon` / `window.trayIcon`.

> Note: `renderer/pet.png`, `pet-*.png`, `tray-icon.png`, and `icon.png` are personal assets and are gitignored — they are not shipped with the repo or the npm package; each user drops in their own.

## Development

```sh
npm run typecheck
npm run build
npm test
```

See `CONTRIBUTING.md`. The vendored SDK is generated — refresh with `npm run sync-vendor <path/to/deepseek-harness>`; don't hand-edit it.

## License

[MIT](LICENSE). The vendored SDK artifacts derive from deepseek-harness (MIT) — see `vendor/README.md`.
