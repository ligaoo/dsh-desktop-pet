# desktop-pet — DeepSeek Harness 桌宠（独立版）

一个独立的 DeepSeek Harness 桌宠项目：用 Electron 透明无边框置顶窗口悬浮一只小宠物，实时镜像一个 agent 会话的活动（空闲 / 思考 / 执行工具 / 说话 / 出错），双击打开聊天面板与 agent 对话。**万物皆插件**：运行时、快照状态、聊天桥、窗口，以及任何外部扩展，都是挂在同一个 `PetHost` 上的插件。

本项目由 deepseek-harness 仓库中的 `packages/extensions/desktop-pet` 独立出来：

- 不再依赖 monorepo：SDK 客户端（`@deepseek-ai/dsh-sdk-client`）的构建产物被 vendor 进 `vendor/`（见 [vendor/README.md](vendor/README.md)），`npm install` 只拉取 `electron`；
- 原来"包根即 Cordis 插件"的耦合被拆成一套自研的轻量插件系统（约 200 行的 `PetHost` + `definePlugin`），内置 `runtime`/`state`/`bridge`/`window`/`notifier`/`identity`/`memory` 七个插件，外部插件可从 `plugins/` 目录或配置文件自动发现；
- 保留两条接入 DSH 的路径：独立运行（SDK 客户端驱动自己的 runtime 子进程）与挂载进 harness 宿主（`harness-host` 入口，作为 cordis.yml 行被加载）。

## 目录结构

```
src/
  core/       插件系统：host / plugin / schema / config / loader / credentials，以及 Electron 无关的宠物核心（state / bridge / launch）
  plugins/    内置插件：runtime / state / bridge / window / notifier / identity / memory
  entries/    CLI 入口、Electron 主进程入口、harness-host 挂载入口
  sdk.ts      唯一访问 vendored SDK 的门面
renderer/     窗口渲染层（纯 CSS 宠物 + 聊天面板 + 图片皮肤）
vendor/       vendored SDK 构建产物 + 类型桩（scripts/sync-vendor.mjs 可刷新）
tests/        单元测试（原扩展测试全部保留并新增插件系统/记忆/通知测试）
examples/     示例外部插件
```

## 运行要求

- **Node.js ≥ 22.19**（`engines` 已声明；Electron 39 需要）；
- 一个可用的 **DeepSeek Harness runtime**：默认 `dsh-jsonrpc-agent` 需在 `PATH` 上（来自已安装的 deepseek-harness），或用 `DSH_PET_RUNTIME` / 配置指向任意符合 SDK 协议的 runtime 入口；
- **凭证**：`DEEPSEEK_API_KEY` 环境变量，或已配置的 harness 凭证库（`~/.dsh/.credentials.yaml`）——桌宠会自动补位，无需单独配置（见下方「凭证说明」）。

## 快速开始

```sh
npm install          # 只安装 electron（含二进制下载）与开发工具
npm run build        # tsc 编译到 lib/
npm test             # vitest 跑全部单测

DEEPSEEK_API_KEY=… npm start          # 启动桌宠窗口（electron lib/entries/window.js）
DEEPSEEK_API_KEY=… npm run pet        # 等价：node lib/entries/cli.js
```

窗口默认以 `dsh-jsonrpc-agent` 为 runtime（需在 PATH 上，或通过配置/环境变量指定）。宠物本体可拖动，双击开合聊天面板，面板右上角 × **收起**面板（桌宠继续运行）；退出走托盘右键菜单。所有对话共享同一个会话 id（`desktop-pet`），窗口内上下文持续保留。

**随时唤起桌宠**：
- **系统托盘**（右下角时钟旁）：单击蓝色圆点图标 = 唤起桌宠并展开聊天；右键菜单：显示桌宠 / 退出（`window.tray: false` 关闭）；
- **全局快捷键**：`Ctrl+Shift+P` 随时唤起（`window.hotkey` 可改，空字符串关闭）；
- 没在运行时：双击 `start-pet.bat`（或 `npm start`）；一键重启用 `restart-pet.bat`。

**回复是流式的**：`assistant/chunk` 的 `text-delta` 片段会被实时累积进气泡（`core/bridge.ts`），逐字显示，而不是等整轮结束。回复期间宠物只切换表情动画，不再在头顶显示工具名。每次宠物启动使用独立的会话存储（`DSH_SESSION_ROOT=<cwd>/.sessions/<pid>`），避免与上次启动的持久化日志冲突。

无 runtime 时窗口照常打开；runtime 在第一条消息时才懒启动，握手失败会显示为宠物的 `error` 表情。

### 给宠物命名

配置文件顶层加 `name` 即可（默认 `桌宠`）：

```jsonc
{ "name": "小蓝", ... }
```

名字会出现在：窗口标题、聊天面板头部、托盘提示；并且宠物背后的 agent 也会知道这个名字（每次启动的首条消息会附带一句身份说明，之后的消息原样发送）——你可以直接喊它的名字。也可以走 `plugins.identity.name`（更具体，优先于顶层 `name`）。

### 长期记忆与人格（完整的「人」）

`memory` 插件让宠物有跨重启的完整记忆和稳定人格，数据存在 `data/`（已 gitignore）：

- **`data/persona.md`** —— 宠物的人设/性格，首次启动自动生成默认版，**直接编辑即可重塑它**（改完重启生效）；
- **`data/memory.json`** —— 三类记忆：`facts`（关于你的事实）、`episodes`（过往对话提炼出的摘要）、`history`（最近对话工作记忆）；
- 每次启动的首条消息会把人设 + 事实 + 摘要 + 最近对话一起注入，所以重启后它仍记得自己、记得你、记得聊过什么。

**记忆指令**（直接对话即可）：

| 你说 | 效果 |
|---|---|
| 「记住：我喜欢猫」 | 写入长期事实（也支持"请记住：…"/"帮我记住：…"/"别忘了：…"） |
| 「忘了：我喜欢猫」 | 按关键词删除相关事实 |
| 「你记得什么」 | 让它把当前记着的事实和过往记忆念给你听 |

**自动整理（情节记忆）**：工作记忆超出上限时，桌宠会在后台把溢出的对话**提炼成摘要存进 `episodes`**（单独会话、不打扰聊天），不再粗暴丢弃。

```jsonc
{ "plugins": { "memory": { "dir": "data", "maxHistory": 40, "maxFacts": 100, "maxEpisodes": 100 } } }
```

## 配置

配置文件默认为 `./desktop-pet.config.json`（或 `DSH_PET_CONFIG`、`--config` 指定；也支持 `.js/.mjs/.cjs` 模块导出配置对象）。完整示例见 [desktop-pet.config.example.json](desktop-pet.config.example.json)。

```jsonc
{
  "defaults": { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
  "plugins": {
    "runtime": { "command": "dsh-jsonrpc-agent", "args": [] },
    "bridge":  { "sessionId": "desktop-pet" },
    "window":  { "alwaysOnTop": true, "title": "DeepSeek 桌宠" },
    "./plugins/my-plugin.mjs": { "anyOption": 1 }   // 外部插件
  },
  "pluginDirs": ["plugins"]
}
```

- 插件的值为 `false` 表示禁用；缺省时内置插件全部启用（`window` 在非 Electron 环境默认禁用）。
- 每个插件行会先合并 `defaults`，再合并自己的选项。
- 保留原扩展的环境变量契约（配置文件的显式值优先，环境变量只填空缺）：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_PET_RUNTIME` | `dsh-jsonrpc-agent` | runtime 可执行文件（须在 PATH 上） |
| `DSH_PET_RUNTIME_ARGS` | `[]` | runtime 附加参数（JSON 字符串数组） |
| `DSH_PET_CWD` | `process.cwd()` | 会话工作目录 |
| `DSH_PET_PROVIDER` | `deepseek-official` | provider 路由 |
| `DSH_PET_MODEL` | `deepseek-v4-flash` | 对话模型 |

`DEEPSEEK_API_KEY` 通过继承环境到达 runtime，与 SDK client 一致。

### 凭证（API Key）说明：不需要单独配置

桌宠进程**自己从不发起任何模型请求**——模型体验完全由它拉起的 `dsh-jsonrpc-agent` runtime 子进程负责。除此之外，桌宠还会在启动 runtime 前主动补 key：`runtime` 插件构建子进程环境时，若环境里没有 `DEEPSEEK_API_KEY`，会自动从 harness 凭证库（`$DSH_HOME/.credentials.yaml`）读出来注入（`src/core/credentials.ts`）。所以链路是：

1. 环境变量 `DEEPSEEK_API_KEY`（最高优先级，CI/显式导出优先）；
2. 桌面宠物自动从 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`，harness Models 页 / `dsh credentials set` 管理的存储）注入；
3. runtime 内还有启动目录 `.env`、`$DSH_HOME/.env` 只读兜底。

所以在已配置过 harness 的机器上，桌宠**零额外配置**即可对话（启动日志会显示 `api-key=injected`）。只有当你打算在一个完全没有凭证的环境里跑桌宠（新机器、系统服务、无 shell 上下文）时，才需要补一次 `DEEPSEEK_API_KEY=xxx npm start`——这也只是补环境变量，不是给桌宠单独建立一套 key 配置。

## CLI

```
desktop-pet [--config <path>] [--headless] [--window] [--plugin-dir <dir>]
            [--list-plugins] [--prompt <text> --headless] [--json] [--version] [-h|--help]
```

- `--headless`：不启动窗口，只跑 runtime+state+bridge（脚本/测试用）；
- `--headless --prompt "你好"`：发一条消息、打印回复后退出（`--json` 输出快照事件流）；
- `--list-plugins`：列出内置与已发现的外部插件。

## 万物皆插件

### 插件接口

```ts
export interface PetPlugin<TConfig extends object = object> {
  name: string                    // 唯一名称，也是配置文件里的键
  version?: string
  description?: string
  requires?: string[]             // 必须先于本插件启动的插件
  optional?: string[]
  config?: Schema<TConfig>        // 选项校验（core/schema.ts 提供组合子）
  setup(ctx: PluginContext<TConfig>, config: TConfig): Disposer | Promise<Disposer>
}
```

`PetHost` 负责：按依赖边拓扑排序启动 → 逐个 `setup` → 结束时**逆序**执行 disposer；`requires` 缺失或依赖成环会直接报错中止；单个插件 `setup` 失败默认记日志跳过（可用 `fatalPlugins` 改成致命错误）。

### 插件上下文（PluginContext）

```ts
ctx.on(event, handler) / ctx.emit(event, payload)   // 事件总线（订阅返回 disposer）
ctx.get<T>(key) / ctx.provide<T>(key, value)        // 服务共享（getOrThrow 快速取）
ctx.config                                          // 合并后的选项
ctx.logger                                          // 带插件名前缀的日志
ctx.host.dispose()                                  // 请求整机退出（window 插件用它）
```

### 内置插件与事件/服务

| 插件 | requires | 提供服务 | 说明 |
|---|---|---|---|
| `runtime` | — | `harness` | 解析 launch（env/config），拥有 `DeepSeekHarness` 子进程，懒启动 |
| `state` | — | `state` | 快照唯一真源：纯 reducer 折叠通知，变更时发 `state:changed` |
| `bridge` | `runtime` | `pet` | 会话串行化 + 快照折叠（包装 `DesktopPetBridge` 核心），变更时发 `snapshot`、`turn:done`、`approval:asked` |
| `window` | `bridge` | — | Electron 窗口 + IPC（含审批卡片）+ 退出流程绑定 host 拆卸 |
| `notifier` | — | — | 桌面通知 + 审批卡片：任务完成/审批请求弹通知，点击聚焦宠物或跳转 URL；本地 HTTP 通知/审批口 |

内置事件：`snapshot`、`state:changed`、`harness:started`、`harness:closed`、`turn:done`、`approval:asked`、`approval:shown`、`approval:respond`、`pet:focus`、`quit`、`plugin:started/disposed/error`。外部插件可以自行扩展事件与服务键。

### 桌面通知与审批（notifier + harness-host 桥）

`notifier` 插件把 harness 活动变成桌面通知和审批卡片（默认随窗口启用）：

- **任务完成**：一轮对话带着回复结束 → 弹「任务完成」通知（正文是回复摘要）；
- **审批请求**：`approval/asked`（宠物自己的 runtime）或宿主桥推来的审批 → 弹「需要审批」通知，并在聊天面板出现**批准/拒绝卡片**；
- **点击通知**：默认把桌宠窗口带到前台并展开聊天面板；配置了 `jumpUrl` 则用系统浏览器打开（可指向主 harness 的会话页）；
- **本地端点**：默认 `127.0.0.1:17890` —— `POST /notify`（仅通知）、`POST /approval`（宿主推审批，带 `respondUrl`）、`POST /approval-respond`（决策回传/脚本驱动）、`GET /health`：

```sh
node scripts/notify-pet.mjs "需要审批" "bash 工具请求执行" "http://localhost:PORT/#/session/xxx"
```

配置项：`taskDone`、`taskDoneOnlyWhenUnfocused`（默认 true：桌宠窗口处于焦点时**不**弹任务完成通知，避免正在对话时被自己打扰；离开窗口才提醒）、`approvals`、`focusPetOnClick`、`jumpUrl`、`notifyPort`、`notifyPortFile`、`approvalTimeoutMs`。

**接入主 harness（完整链路）**：把 `harness-host` 入口作为插件行挂进 harness 宿主（如 dsh 的 cordis.yml），它会：

1. 观察 `session/event`：`approval/asked` → 推「需要审批」、`turn/end`（completed）→ 推「任务完成」，带 `jumpUrl`（`webBaseUrl` + `sessionPath` 模板）；
2. `answerApprovals: true` 时注册 `approval/request` 应答器（prepend 优先）：请求推给桌宠 → 桌宠卡片点「批准/拒绝」→ 决策 POST 回宿主的应答端点 → waterfall 以 `allowed-once`/`rejected` 解决；超时（`responseTimeoutMs`）则 `next()` 让给后续应答器（如 Web UI）；
3. 退出时自动清理。

```yaml
- id: desktop-pet
  name: 'desktop-pet/harness-host'
  config:
    notifyUrl: 'http://127.0.0.1:17890'
    webBaseUrl: 'http://localhost:8090'        # 主 harness Web UI 地址
    sessionPath: '/#/session/{sessionId}'      # 会话页路由模板
    answerApprovals: true
```

> **边界**：宠物**自己**的 runtime（SDK 子进程）目前不会主动要审批（捆绑 cordis.yml 未挂审批服务，SDK 协议也无审批应答方法）；审批应答能力走的是**宿主侧**（上面的 harness-host 桥 + 桌宠卡片），这条链已端到端验证（宿主推审批 → 桌宠弹卡片 → 点批准 → 决策回传 → waterfall 解决）。

### 写一个外部插件

把下面这个文件放进 `plugins/`（或 `pluginDirs` 指向的目录、或在配置里按路径引用），下次启动自动加载：

```js
// plugins/snapshot-logger.mjs
export default {
  name: 'snapshot-logger',
  description: '记录宠物每个表情变化',
  setup(ctx) {
    return ctx.on('snapshot', (snapshot) => {
      ctx.logger.info(`mood -> ${snapshot.mood}`)
    })
  },
}
```

完整示例见 [examples/plugins/snapshot-logger.mjs](examples/plugins/snapshot-logger.mjs)。

## 接入 DeepSeek Harness 的两种方式

1. **独立模式（默认）**：宠物是一个 SDK 客户端，直接 spawn 自己的 `dsh-jsonrpc-agent` runtime 子进程并走 stdio JSON-RPC 对话——即原扩展的运行时对等关系，不注册进任何 Cordis 上下文。
2. **宿主挂载模式**：`harness-host` 入口符合 Cordis 插件契约（`name`/`apply`/`Config`），在 harness 宿主（如 dsh 的 cordis.yml）里加一行即可把宠物窗口作为受管子进程拉起，宿主行卸载时自动杀掉：

```yaml
- id: desktop-pet
  name: 'desktop-pet/harness-host'
  config:
    model: deepseek-v4-pro
```

该入口对 `@deepseek-ai/cordis` **零编译期依赖**（只按结构使用 `ctx.logger`/`ctx.effect`），所以独立项目不需要 vendor cordis。

## 更换桌宠外观 / 窗口图标

宠物本体是 `renderer/` 里的静态资源（`index.html` 结构 + `pet.css` 造型动画 + `pet.js` 按 mood 切换状态），**只改 renderer 不需要重新构建**，改完重启桌宠即可。

**方式一：换成你自己的图片（零代码，推荐）**
把图片丢进 `renderer/` 即可，重启桌宠自动生效——无需改任何代码：

- 通用皮肤：`renderer/pet.png`（所有状态共用一张）；
- 分状态皮肤（可选，优先于通用图）：`pet-idle.png`、`pet-thinking.png`、`pet-acting.png`、`pet-speaking.png`、`pet-error.png`（思考/执行/说话/出错各有表情）；
- 建议透明底 PNG，尺寸约 132×128；没有图片时自动回退到内置的 CSS 宠物。
- 注意：`renderer/pet.png` / `pet-*.png` / `tray-icon.png` / `icon.png` 属于**个人素材，已被 `.gitignore`**，不会随仓库或 npm 包发布——每个人放自己的图即可（这正是期望行为）。

**方式二：换颜色 / 造型（纯 CSS）**
编辑 `renderer/pet.css`，例如身体颜色在 `.body` 的 `background: radial-gradient(...)`（`#c9e4ff`/`#7fb8f5`/`#4a90e2`/`#2f6cb8` 色标），出错状态在 `.mood-error .body`。

**窗口图标（Alt-Tab / 任务栏）**
`window` 插件支持 `icon` 选项，路径相对包根（如 `renderer/icon.png`，支持 PNG/ICO）：

```jsonc
{ "plugins": { "window": { "icon": "renderer/icon.png" } } }
```

改 `src/` 或配置后需要 `npm run build` 再 `npm start`。

## 测试

```sh
npm test
```

- 原扩展的 `state` / `bridge` / `launch` 测试全部保留（Electron 无关，纯 Node 可跑）；
- 新增：`host`（生命周期/依赖排序/服务/事件）、`config`（文件+env 合并）、`loader`（外部插件发现）、`schema`、`credentials`、`harness-host`（挂载配置与子进程 env 映射）、`harness-bridge`（审批应答全链路）、`notifier`（通知/审批端点）、`memory`（长期记忆/情节/整理）、`plugins`（内置插件接线）。

## 开发与贡献

欢迎参与！本项目"万物皆插件"——大多数改动就是**新增一个插件**或**修一个插件**。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)，关键约定：

- 插件是变更单元：用 `definePlugin({ name, requires?, config?, setup })`（见 `src/plugins/*.ts` 与 `examples/plugins/`）；
- Electron 无关的核心保持可测：凡是碰 `electron` 的代码都懒加载，行为落在纯 Node 可测的模块里；
- `vendor/` 是生成物，别手改——用 `npm run sync-vendor` 刷新（见下方）；
- 提交 PR 前跑 `npm run typecheck && npm run build && npm test`。

CI（`.github/workflows/ci.yml`）会在每次 push / PR 上跑 typecheck + build + test。

## vendor 说明与刷新

`vendor/` 里的 SDK 构建产物来自 deepseek-harness 仓库（MIT 协议），`scripts/sync-vendor.mjs` 负责从 checkout 复制并重写内部 import 为相对路径。升级 SDK 后：

```sh
npm run sync-vendor <path/to/deepseek-harness>   # 刷新
npm run sync-vendor:check                        # 校验是否过期
```

## 已知局限（继承自原扩展）

- **纯 CSS 视觉**：宠物是 CSS 关键帧形状，sprite/Live2D 资产与更丰富的动画集留待美术管线；
- **不支持中途取消**：SDK 线上没有 prompt-cancel，关窗即整体拆卸 runtime；
- **单会话、无历史 UI**：所有聊天共享 `desktop-pet` 会话，聊天记录只活在窗口生命周期内；
- **窗口不可在无头 CI 测试**：`window` 插件、preload、renderer 需要显示器；行为覆盖集中在 Electron 无关的核心。

## 许可

[MIT](LICENSE)。`vendor/` 下的 SDK 构建产物源自 deepseek-harness（MIT），详见 `vendor/README.md`。
