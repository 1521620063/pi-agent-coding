# PI VS Code Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户本机 PI 的原生能力接入 VS Code 侧边栏；交互组织参考 Codex / Claude Code，界面的样式风格尽量参考 PI 本身。

**Architecture:** Webview 负责显示和输入，VS Code 扩展宿主负责编辑器上下文、状态与进程管理，通过 JSONL RPC 控制用户已安装的 PI。推理、工具、技能、MCP、模型和会话内容由 PI 管理；不把 PI SDK 或智能体运行库打进插件。

**Tech Stack:** TypeScript、VS Code Extension API、原生 TypeScript Webview、esbuild、Vitest + jsdom（DOM 单测）、VS Code Extension Development Host / `@vscode/test-electron` + Mocha（宿主测试）、`@vscode/vsce`。开发时选择兼容的依赖版本并提交 lockfile；本文不声称这些依赖已经安装。

**Spec:** [PI VS Code 侧边栏桥接插件设计](../specs/2026-11-11-pi-vscode-bridge-design.md)。用户已于 2026-11-11 要求开始开发。

## 实施状态（2026-11-11）

任务 1–11 的功能代码已实现，任务 12 已产出 VSIX 并完成本地安装验证。以下是实际状态；原逐步清单包含尚未全部完成的复合验收条件，保留未勾选，不能解读为全部验收通过。详细记录见 [验证文档](../../testing.md)。

| 范围 | 实现 | 已验证 | 尚未验证 |
| --- | --- | --- | --- |
| P0：任务 1–7 | 完成 | 单元/集成/VS Code 宿主，真实 PI 文本、工具、图片、模型及会话 RPC | 完整多根/无工作区窗口矩阵、其他平台 |
| P1：任务 8–9 | 完成 | 队列与停止、真实用量、重试/压缩夹具、真实小会话压缩拒绝 | 长会话成功压缩、真实供应商重试故障 |
| P2：任务 10–11 | 完成 | 真实历史树、分叉、复制、导出、PI shell；扩展交互/通用工具夹具 | 已配置 MCP 与扩展交互的真实环境 |
| 任务 12 | 包及文档完成 | check、40 单测、5 进程集成、5 宿主测试、11 文件 VSIX；隔离安装后再跑 5 宿主测试 | 原生 VS Code 完整视觉/辅助功能矩阵、独立代码审查 |

视觉验收采用实际构建产物的浏览器夹具：暗色/浅色/高对比度，各 320px / 480px 与等效 200% 缩放，共九张截图；不是原生 VS Code 截图。宿主测试合并在 `tests/vscode/suite.ts`，运行器为 `scripts/test-vscode.mjs`。独立审查工具因消息丢失/连接超时未完成，已执行本地逐模块复核与回归测试。当前工作在 `feat/pi-sidebar` 分支及 `.worktrees/pi-sidebar`，未合并或推送。

## Global Constraints

- 1.5.2 是本机验证基线，不代表所有 PI 版本都兼容。
- 首版仅承诺本地 VS Code 扩展宿主。
- 视觉优先参考 PI 自身的消息、工具、输入区和 footer；具体遵循设计说明 3.8，所有开发阶段均适用。
- 每个 VS Code 窗口首版只维护一个当前工作区 PI 进程；隐藏侧栏不停止已有任务。
- 默认不覆盖模型、工具、技能或会话目录。
- 插件不安装 PI，也不收集或保存供应商凭证。
- 扩展不导入 PI 的智能体运行库，不直接调用模型 API。
- Webview 不直接访问文件系统、创建进程或连接供应商。
- 未受信任工作区不启动 PI。
- 首版不创建变更审批引擎、文件快照、自动回滚或逐块接受/拒绝功能。
- 分叉改变对话上下文，不回滚文件。
- 插件不再叠加自己的模型请求重试循环。
- Windows 是首个实际验证平台；macOS、Linux 仅在实际验证后声明支持。

## Review Focus

1. 中文输入法还在组合输入、选区来自未保存的编辑器：发送不能打断输入，附件必须使用用户当前看到的内容；对应任务 4、5。
2. PI 快速返回 handled、乱序响应、UTF-8 跨块或自动恢复：请求不串线，运行不提前结束；对应任务 2、4。
3. 关闭侧栏、重载 Webview、进程崩溃或 Windows 启动器产生子进程：不丢运行状态、不重复执行、不遗留进程；对应任务 3、4。
4. 活动队列存在时停止、扩展取消会话切换、确认框超时后用户仍点击：不继续执行旧任务、不切错会话、不重复应答；对应任务 7、8、11。
5. 切到纯文本模型、压缩后统计为 null、未知 MCP 工具或超长输出：明确限制和缺失值，保持界面可响应；对应任务 4、5、9、11。

## 1. 阶段与推荐顺序

| 阶段 | 任务 | 阶段完成的标志 |
| --- | --- | --- |
| P0：可用闭环 | 1–7 | 真实 PI 聊天、工具展示、停止、图片、模型选择、`/` 技能菜单和会话恢复可用 |
| P1：推荐首发 | 8–9，随后做任务 12 的首发验收 | 增加队列可视化、用量、压缩与重试控制，可用于日常工作 |
| P2：后续增强 | 10–11，最后重复任务 12 的相关验收 | 分叉/复制/树/导出、扩展状态组件和命令面板可用 |

推荐首发为 P0 + P1。用户可以先做到 P0 验证桥接，但不要将其描述为本文全部功能已完成。P2 只有对应验收通过后才标记完成。

## 2. 文件职责与共同接口

当前仓库只有 README、LICENSE 和设计文档；以下源文件均为**未来创建**。不要在阅读计划时安装依赖或创建产品代码。

| 路径 | 职责 |
| --- | --- |
| `package.json`、`tsconfig.json`、`esbuild.config.mjs`、`vitest.config.ts`、`.vscode/launch.json`、`.vscodeignore` | 扩展声明、构建、调试、测试和打包；依赖锁定 |
| `src/extension.ts`、`media/pi.svg` | 扩展生命周期和活动栏入口 |
| `src/sidebar/provider.ts`、`src/shared/bridge.ts` | Webview 提供器、宿主消息校验及视图协议 |
| `src/pi/protocol.ts`、`src/pi/jsonl.ts`、`src/pi/transport.ts` | 本地协议类型、JSONL 解码、请求关联 |
| `src/pi/launcher.ts`、`src/pi/controller.ts` | 本机发现、启动、退出及有状态 RPC 门面 |
| `src/state/session-store.ts` | 流式消息、工具、运行与扩展状态的归并 |
| `src/features/attachments.ts`、`models.ts`、`commands.ts` | 编辑器/图片附件、模型设置、可发现命令 |
| `src/features/sessions.ts`、`queues.ts`、`context.ts` | 会话索引、消息队列、统计/压缩/重试 |
| `src/features/history.ts`、`extension-ui.ts`、`shell.ts` | 分叉/树/导出、扩展交互、独立命令面板 |
| `webview/main.ts`、`theme.css`、`styles.css`、`chat.ts`、`attachments.ts`、`menus.ts`、`history.ts`、`dialogs.ts` | PI 语义主题、侧栏、时间线、附件、菜单和交互组件 |
| `tests/unit/`、`tests/fixtures/fake-pi.mjs`、`tests/integration/` | 桥接逻辑与模拟子进程测试 |
| `tests/vscode/run.ts`、`suite.ts` 及宿主用例、`docs/testing.md` | 启动测试扩展宿主、Mocha 入口、真实 PI 验收和平台结果记录 |

约定只在其所属任务创建文件，按任务需要扩展类型，不提前建立空目录或占位模块。协议类型依据本机安装包 `docs/rpc-commands.md`、`docs/json.md`、`docs/rpc-extension-ui.md` 和 `rpc-types.d.ts` 定义，不能直接引用安装目录中的模块，也不能把网络 main 分支当成版本基线。

共同接口约定如下；涉及的类型在任务标注的文件定义并导出：

| 接口 | 定义与含义 |
| --- | --- |
| `Unsubscribe` | `() => void`，定义在 `src/shared/bridge.ts` |
| `ViewState`、`ClientAction`、`HostMessage` | 定义在 `bridge.ts`；状态至少含 connection、workspace、session、run、messages、tools、queues、pendingUi、attachments、models、commands、stats、compaction、retry；消息采用带 type 的判别联合 |
| `SessionStore` | `getSnapshot(): ViewState`、`subscribe(listener: (state: ViewState) => void): Unsubscribe`、`apply(record: PiRecord): void`，定义在 `session-store.ts` |
| `RpcTransport` | `request<T>(command: RpcCommand, options?: RequestOptions): Promise<T>`、`send(record: ExtensionUiResponse): Promise<void>`、`onRecord(listener: (record: PiRecord) => void): Unsubscribe`、`dispose(): void`，定义在 `transport.ts` |
| `RequestOptions` | `{ timeoutMs?: number; signal?: AbortSignal }`；request 返回成功 response 的 data，失败 response 转为带 command/id 信息的错误 |
| `PiController` | `connect(workspaceUri: string): Promise<void>`、`request<T>(command: RpcCommand, options?: RequestOptions): Promise<T>`、`respond(record: ExtensionUiResponse): Promise<void>`、`stopAll(): Promise<void>`、`disconnect(): Promise<void>`、`onRecord(listener: (record: PiRecord) => void): Unsubscribe`，定义在 `controller.ts` |

`RpcCommand`、`PiRecord`、`ExtensionUiResponse` 在 `protocol.ts` 定义；`RequestOptions` 在 `transport.ts` 定义。所有来自进程与 Webview 的未知输入先校验再进入类型系统。`workspaceUri` 是 VS Code 文件 URI，由宿主转换为 cwd；禁止 Webview 直接提供任意 cwd 或可执行文件路径。

构建后的脚本约定：`npm run compile` 构建宿主和 Webview，`npm run check` 类型检查，`npm test -- <test-file>` 运行一次测试，`npm run test:integration` 运行模拟进程测试，`npm run test:vscode` 运行扩展宿主测试，`npm run package` 生成 VSIX。开发时在 package.json 中落实这些命令；本文中的命令不是已运行的结果。

### PI 视觉约束的实施位置

- `webview/theme.css` 管理 `--pi-*` 语义颜色，角色与 PI accent、userMessage、thinking、toolPending/Success/Error、toolDiff、muted、border 对应；`styles.css` 管理布局。借鉴 PI system 的自适应思路，以 VS Code 当前调色板为宿主，dark/light 为对照，禁止硬编码整页深色。
- 任务 1 确立紧凑布局、底部输入区和状态行；任务 4 实现用户浅底色块、助手连续正文和工具平面区块；任务 9 将用量融入 footer；任务 11 的控件保持同一套视觉规范。
- 不通过 RPC 同步终端主题、不读取未知路径中的主题脚本、不将 OKHSL 字符串直接写为 CSS。需要具体颜色时转换为 CSS 支持的表示；高对比度和焦点优先服从 VS Code 的可读性约束。
- 任务 12 对照 PI 实际界面，记录明暗/高对比度、320px / 480px 和 200% 缩放的截图；视觉检查记录实际结果，不为静态 CSS 细节编写实现镜像测试。

## 3. P0：可用闭环

### Task 1：侧栏入口、状态协议与构建基础

**Files:** 创建构建/调试/打包/单测配置、`src/extension.ts`、`src/shared/bridge.ts`、`src/pi/protocol.ts`（最小类型）、`src/sidebar/provider.ts`、`src/state/session-store.ts`、`webview/main.ts`、`webview/theme.css`、`webview/styles.css`、`media/pi.svg`；测试 `tests/unit/sidebar-channel.test.ts`。

**Interfaces:** 产出 `ViewState`、`ClientAction`、`HostMessage`、`Unsubscribe` 和 `SessionStore`；`createSidebarProvider(store: SessionStore, onAction: (action: ClientAction) => Promise<void>)` 返回 `vscode.WebviewViewProvider & vscode.Disposable`。初始 connection 为 disconnected，先在 protocol.ts 定义 store 需要的最小 PiRecord 类型，任务 2 再扩充完整 RPC 类型，确保本任务可独立编译。

- [ ] 为 `sidebar-channel.test.ts` 编写有行为价值的用例：`ready` 返回当前完整 snapshot；未知 action 被拒绝；Webview 自报文件路径不能触发文件读取。
- [ ] 在落实最小测试工具后运行 `npm test -- tests/unit/sidebar-channel.test.ts`，确认因消息通道尚未实现而失败；不要为清单字段或静态文案写镜像测试。
- [ ] 实现 `pi.sidebar` Webview、`pi.open` 命令和 manifest 贡献点，完成 CSP、PI 语义主题变量、状态恢复消息、输出通道；布局参考 PI 的文本优先界面、细分隔和紧凑底栏，先显示真实的未连接状态，不生成模拟聊天。
- [ ] 运行上述测试、`npm run check`、`npm run compile`；F5 启动扩展宿主，确认活动栏可打开侧栏，按设计 3.8 对照 PI 的界面层次，明暗主题、高对比度和窄宽度可读。
- [ ] 提交：`feat: add PI sidebar shell and host message channel`。

### Task 2：JSONL 传输和有类型的 RPC 请求

**Files:** 扩展 `src/pi/protocol.ts`；创建 `src/pi/jsonl.ts`、`src/pi/transport.ts`；测试 `tests/unit/jsonl.test.ts`、`rpc-transport.test.ts`。

**Interfaces:** 产出共同接口中的 `RpcTransport`、`RequestOptions`；`createRpcTransport(streams: { stdin: Writable; stdout: Readable }): RpcTransport`，流类型来自 `node:stream`。`JsonlDecoder.push(chunk: Uint8Array): PiRecord[]` 和 `finish(): PiRecord[]` 负责 UTF-8 与 LF 分帧。

- [ ] 写失败测试：中文 UTF-8 字节分片、CRLF、同块多记录、字符串内 U+2028/U+2029 不分行；两个请求响应乱序仍返回对应 data；success false、超时、退出和 stdin 背压各自正确结束请求。
- [ ] 运行 `npm test -- tests/unit/jsonl.test.ts tests/unit/rpc-transport.test.ts`，确认缺少实现时失败。
- [ ] 实现唯一请求 ID、事件订阅、完整记录校验和待处理请求清理；stdout 只按协议处理，stderr 留给 controller；不要使用 Node readline 分割协议。
- [ ] 重跑上述测试及 `npm run check`，预期全部通过；无 ID 事件不误匹配请求，扩展 UI response 不等待普通 response。
- [ ] 提交：`feat: implement PI JSONL RPC transport`。

### Task 3：本机发现、Windows 启动和进程清理

**Files:** 创建 `src/pi/launcher.ts`、`controller.ts`、`tests/fixtures/fake-pi.mjs`；修改 `src/extension.ts`；测试 `tests/unit/launcher.test.ts`、`tests/integration/controller.test.ts`。

**Interfaces:** `resolvePiLaunch(config: { executablePath?: string }, env: NodeJS.ProcessEnv): Promise<LaunchSpec>`；`LaunchSpec = { command: string; args: string[]; env: NodeJS.ProcessEnv }` 定义在 launcher；controller 按共同接口对外服务，向 store 发布真实状态。

- [ ] 写失败用例：PATH 与显式路径发现；含空格/中文的路径与工作区；找不到 PI、非可信/远程/无工作区被阻止；启动器退出与真正 PI 子进程都能清理。
- [ ] 运行 `npm test -- tests/unit/launcher.test.ts` 与 `npm run test:integration -- tests/integration/controller.test.ts`，确认测试覆盖尚未实现的启动与关闭行为。
- [ ] 实现 `pi --version` 检测、官方启动器兼容和 `pi --mode rpc` 启动；不硬编码本机安装目录。先订阅事件再 `get_state` 验证握手；命令参数不经过用户文本拼接。对 PI 自身的项目信任或登录错误展示诊断，不静默添加 `--approve`。
- [ ] 实现 stdin EOF 有序退出、超时后仅清理本次创建的进程树；断连拒绝挂起请求，不自动重放 prompt；控制请求默认 10 秒、启动握手 60 秒、关闭等待 5 秒，允许设置覆盖，长任务另设取消而非沿用短超时。
- [ ] 重跑模拟测试并用真实本机 PI 执行版本、`get_state`、正常关闭的无模型握手；记录退出后没有遗留子进程，再提交 `feat: connect installed PI and manage its lifecycle`。

### Task 4：流式聊天、工具卡片与基础交互

**Files:** 修改 `session-store.ts`、`controller.ts`、`bridge.ts`、`provider.ts`、`webview/main.ts`；创建 `webview/chat.ts`、`src/features/extension-ui.ts`；测试 `tests/unit/session-store.test.ts`、`webview-chat.test.ts`、`extension-ui.test.ts`。

**Interfaces:** store.apply 处理已验证的 `PiRecord`；controller 的 `stopAll()` 顺序为 `clear_queue` 再 `abort`。`ExtensionUiManager.handle(record: ExtensionUiRequest): void`、`reply(id: string, result: UiAnswer): Promise<void>` 定义在 extension-ui；两个类型分别来自 protocol 和 bridge。

- [ ] 写失败用例：text/thinking delta 后 message_end 权威快照不重复拼接；prompt disposition=handled 不陷入运行；agent_end 后重试到 agent_settled 才结束；未知工具名、图片结果和大输出可折叠展示。
- [ ] 增加用例：Webview 重新 ready 后仍恢复活动对话；composition 期间 Enter 不发送；Markdown 中 HTML、脚本及 command 链接不执行；confirm/select/input/editor 请求能回答或取消且只回答一次。
- [ ] 运行 `npm test -- tests/unit/session-store.test.ts tests/unit/webview-chat.test.ts tests/unit/extension-ui.test.ts`，确认新增行为在实现前失败。
- [ ] 实现流式渲染、代码块、停止、状态说明、工具卡片；用户消息为 PI 风格浅底色块，助手为连续正文，工具为中性/绿/红语义的紧凑平面区块，不做头像气泡布局。仅识别校验过的 `edit` details 中 diff/patch/firstChangedLine，标注“已修改”，不解析成批准流程；其他工具保持通用展示。初始扩展对话使用 VS Code 标准交互控件，不支持的 custom TUI 明确说明。
- [ ] 重跑测试、check、compile；真实发送一次轻量 PI 请求并停止，用一个临时工程验证工具事件。模拟与真实结果分开记录；提交 `feat: render PI chat tools and native interaction requests`。

### Task 5：文件、选区和图片附件

**Files:** 创建 `src/features/attachments.ts`、`webview/attachments.ts`；修改 bridge、provider、chat；测试 `tests/unit/attachments.test.ts`、`tests/vscode/editor-context.test.ts`。

**Interfaces:** `AttachmentService.fromSelection(editor: vscode.TextEditor): Promise<Attachment>`、`pickFiles(): Promise<Attachment[]>`、`addImage(input: { bytes: Uint8Array; mimeType: string; name: string }): Promise<Attachment>`、`buildPayload(ids: string[]): Promise<{ text: string; images: ImageContent[] }>`；`Attachment` 定义在 bridge，`ImageContent` 定义在 protocol。附件由宿主生成 ID，Webview 只能引用已有 ID。

- [ ] 写失败测试：未保存编辑器的当前选区内容和行号正确；UTF-8 文件作为文本而图片进入 images；移除附件后不进入 prompt；纯文本模型不能发送图片；切换模型后已有图片仍可移除而不能误发。
- [ ] 增加边界断言：无效 MIME 与非图片数据不被接受；只读取用户选中的文档，不由 Webview 任意路径读取文件；粘贴和拖入遵循同一校验。UI 初始限制为单张 5 MiB、全部图片合计 15 MiB，文案清楚说明这是插件限制而非 PI 官方限额。
- [ ] 运行 `npm test -- tests/unit/attachments.test.ts`，确认未实现行为失败；编辑器未保存用例在任务 12 的 VS Code 宿主测试中运行。
- [ ] 实现发送前附件预览/删除、选区命令与文件选择、图片粘贴/拖入；图片通过宿主校验并编码，当前模型 input 缺少 image 时禁用。文本附件附文件名/选区边界，不强制复制整个工作区。
- [ ] 重跑附件测试、check、compile；真实支持图片的模型做一次图片请求，不支持时记录为待验证而非通过；提交 `feat: attach editor context and images to PI prompts`。

### Task 6：模型、思考强度与 `/` 菜单

**Files:** 创建 `src/features/models.ts`、`commands.ts`、`webview/menus.ts`；修改 controller、bridge、附件状态；测试 `tests/unit/models-commands.test.ts`。

**Interfaces:** `ModelService.refresh(): Promise<void>`、`select(provider: string, modelId: string): Promise<void>`、`setThinking(level: ThinkingLevel): Promise<void>`；`CommandService.refresh(): Promise<void>`、`invoke(name: string, args: string): Promise<void>`。`ThinkingLevel`、model 和命令结构在 protocol 按安装版定义。

- [ ] 写失败测试：菜单仅来自 get_available_models/get_available_thinking_levels；切模型后重新获取 thinking 选项；get_commands 中 skill、prompt、extension 均可显示；不把 /settings、/hotkeys 伪造为可执行项。
- [ ] 验证 skill 名如 `skill:review` 保留原样；模板参数经 prompt 交给 PI 展开；没有可发现命令时显示空状态；RPC 拒绝设置时保留原值并展示错误。
- [ ] 运行 `npm test -- tests/unit/models-commands.test.ts`，确认未实现的选择与命令调用失败。
- [ ] 实现下拉菜单与 `/` 搜索；执行时查询当前 run：忙碌的普通模板/技能采用用户已选 steer/followUp，扩展命令按 PI 原生 prompt 语义处理，不自行实现模板和技能运行器。
- [ ] 测试、check、compile 通过后，真实核对本机模型和已有命令列表；提交 `feat: expose PI models reasoning and discoverable commands`。

### Task 7：会话索引、新建、恢复和命名

**Files:** 创建 `src/features/sessions.ts`；修改 sidebar、bridge、menus；测试 `tests/unit/sessions.test.ts`。

**Interfaces:** `SessionService.list(workspaceUri: string): Promise<SessionRef[]>`、`create(): Promise<void>`、`openFromPicker(): Promise<void>`、`resume(ref: SessionRef): Promise<void>`、`rename(name: string): Promise<void>`；`SessionRef = { workspaceUri: string; sessionPath: string; sessionId: string; name?: string; lastOpenedAt: string }` 定义在 sessions。

- [ ] 写失败用例：只列插件打开过的工作区会话；新建/切换成功后由 get_state/get_messages 重建；PI 返回 cancelled 时不丢旧会话；文件已删除时可移除失效索引且不覆盖其他会话。
- [ ] 增加多根工作区选择、恢复到正确 cwd、改名事件同步，以及运行中切换需要先 stopAll 的用例。索引与轻量会话元信息持久化，聊天正文和凭证不写 VS Code storage。
- [ ] 运行 `npm test -- tests/unit/sessions.test.ts`，确认失败，再实现以上接口及文件选择器打开已有 JSONL。
- [ ] 重跑测试、check、compile；关闭/重开侧栏仍显示原状态，重启窗口可显式恢复；不得假设 `list_sessions` 存在，不直接读取 JSONL 拼出当前分支。
- [ ] 提交：`feat: manage PI session references and restoration`。至此完成 P0 的基础范围，按任务 12 做一次闭环检查。

## 4. P1：推荐首发的日常功能

### Task 8：消息队列与自动重试状态

**Files:** 创建 `src/features/queues.ts`、`src/features/context.ts`（RetryService 部分）；修改 bridge 中相应状态、controller、session-store、chat；测试 `tests/unit/queues-retry.test.ts`。

**Interfaces:** `QueueService.submit(message: string, images: ImageContent[], mode: 'steer' | 'followUp'): Promise<void>`、`clear(): Promise<{ steering: string[]; followUp: string[] }>`；`RetryService.setEnabled(enabled: boolean): Promise<void>`、`cancel(): Promise<void>` 在 `src/features/context.ts` 定义。controller.stopAll 仍保持统一顺序。

- [ ] 写失败测试：queue_update 是完整替换而非追加；补充指示不承诺打断当前工具；clear_queue 返回的文本可恢复编辑；stopAll 总是先清队列再取消；若清队列失败，不声称“全部停止”成功。
- [ ] 增加重试事件用例：auto_retry_start/end、失败后自动恢复、summarization_retry_* 不被误判成 idle；取消等待使用 abort_retry，不生成第二套请求重放。
- [ ] 运行 `npm test -- tests/unit/queues-retry.test.ts`，确认失败，再实现队列展示、两种发送模式、自动重试开关和取消入口；开关来源以当前进程已确认的设置为准，RPC 未返回初始值时显示默认/未知而不伪造状态。
- [ ] 重跑测试、check、compile；使用 fake PI 验证 agent_end 后继续运行并最终 settled 的完整序列，以及队列错误/取消时编辑框文本不会丢失。
- [ ] 提交：`feat: expose PI queues and retry lifecycle`。

### Task 9：用量、上下文占用与压缩

**Files:** 扩展 `src/features/context.ts`；修改 bridge、store、sidebar/menus；测试 `tests/unit/context-stats.test.ts`。

**Interfaces:** `ContextService.refreshStats(): Promise<void>`、`compact(customInstructions?: string): Promise<void>`、`setAutoCompaction(enabled: boolean): Promise<void>`；同时保留任务 8 的 RetryService。统计结构使用 protocol 中的 `SessionStats`，不另算账单。

- [ ] 写失败测试：contextUsage 缺失显示不可用；tokens/percent=null 显示等待更新；cost=0 与缺失区分；压缩前后数据和摘要正确，不把 estimatedTokensAfter 当供应商精确计数。
- [ ] 增加压缩取消、失败、overflow 后 willRetry、切换会话时旧统计异步响应返回的用例；旧响应不能覆盖新会话数据。
- [ ] 运行 `npm test -- tests/unit/context-stats.test.ts`，确认失败，再实现参考 PI footer 的紧凑统计状态行、手动压缩弹窗、自动压缩开关和摘要展示，保持低干扰且窄侧栏可换行。compact 属于长任务，不能按普通 10 秒超时误判失败。
- [ ] 在 agent_settled、模型/会话变更、压缩完成后刷新统计，不在每个 token 上请求；测试、check、compile 通过后，真实检查 get_session_stats，人工压缩测试只在专用会话执行并记录结果。
- [ ] 提交：`feat: show PI usage and context compaction`。P0+P1 功能具备后，执行任务 12 的首发验收。

## 5. P2：后续增强

### Task 10：会话分叉、复制、树形历史与 HTML 导出

**Files:** 创建 `src/features/history.ts`、`webview/history.ts`；修改 sessions、bridge、menus；测试 `tests/unit/history.test.ts`。

**Interfaces:** `HistoryService.listForkPoints(): Promise<ForkPoint[]>`、`fork(entryId: string): Promise<{ text?: string; cancelled: boolean }>`、`clone(): Promise<void>`、`getTree(): Promise<SessionTree>`、`exportHtml(): Promise<string | undefined>`；返回结构按 protocol 的 PI 类型定义。成功分叉/复制后调用任务 7 的刷新逻辑更新会话索引。

- [ ] 写失败测试：分叉只接受 get_fork_messages 返回的当前分支用户消息 ID；fork/clone 取消时保留旧状态；成功 fork 返回原始提问文本并回填编辑框而不自动再次发送。
- [ ] 测试树中多根/孤立节点仍可浏览、无 navigate 操作被伪造；分叉与复制不写工作区文件；导出选择取消不发送命令，失败不声称文件已生成。
- [ ] 运行 `npm test -- tests/unit/history.test.ts`，确认失败，再实现只读树、分叉/复制入口和经宿主保存对话框选择路径的 export_html；需要完整历史时使用 get_entries，不把 get_messages 当作全部分支。
- [ ] 重跑测试、check、compile；真实专用会话执行 fork/clone/export_html，核对返回路径与新会话，界面标注“不会回滚文件”。
- [ ] 提交：`feat: add PI conversation branching and export`。

### Task 11：扩展状态、MCP 通用展示与独立命令面板

**Files:** 扩展 `src/features/extension-ui.ts`；创建 `src/features/shell.ts`、`webview/dialogs.ts`；修改 store、bridge、chat；测试 `tests/unit/extension-ui.test.ts`、`shell.test.ts`、`tool-content.test.ts`。

**Interfaces:** 扩展既有 ExtensionUiManager；`ShellService.execute(command: string, excludeFromContext: boolean): Promise<BashResult>`、`cancel(): Promise<void>`，BashResult 在 protocol 定义，输出事件按请求 ID 归并。

- [ ] 写失败测试：确认/选择/编辑/输入响应 ID 对应、取消、超时点击和多次点击最多应答一次；notify/setStatus/setWidget/setTitle/set_editor_text 正常更新，widget 只接受文本行，未知 UI method 不崩溃。
- [ ] 增加 MCP 与自定义工具夹具：未知名称、文本+图片混合内容、缺失 details、错误、超大输出；展示不依赖固定工具名，不创建第二个 MCP 客户端。已有 MCP 的加载依旧由 PI 决定。
- [ ] 测试独立命令流按 ID 归并、abort_bash、截断标记/fullOutputPath、excludeFromContext 布尔值原样发送；执行本身不自动补一条 prompt，提示输出会在下一条模型请求时才进入上下文。
- [ ] 运行 `npm test -- tests/unit/extension-ui.test.ts tests/unit/shell.test.ts tests/unit/tool-content.test.ts`，确认失败，再实现丰富交互展示和默认收起的命令面板；测试通过后用 Windows PI 执行无副作用命令验证实际 shell。禁止靠宿主另开 shell 模拟 PI bash。
- [ ] 运行 check、compile；在已配置 MCP/扩展的环境记录真实验收，缺少此环境则记未验证；提交 `feat: bridge PI extension widgets and shell execution`。

## 6. 发布验收与文档

### Task 12：扩展宿主验证、VSIX 与使用说明

**Files:** 创建 `tests/vscode/run.ts`、`tests/vscode/suite.ts`、`tests/vscode/sidebar.test.ts`、`tests/vscode/lifecycle.test.ts`、`docs/testing.md`；落实任务 5 的 `tests/vscode/editor-context.test.ts`；修改 README、package.json、`.vscodeignore`、`.vscode/launch.json`。run.ts 使用 @vscode/test-electron 启动宿主，suite.ts 运行编译后的 Mocha 用例。P1 和 P2 各执行一次相关范围的验收，不为未完成任务打勾。

**Interfaces:** 消费前述模块和 npm scripts；`docs/testing.md` 按场景分别记录 simulated / real PI / real model、PI/VS Code/Node 版本、平台、结果和未验证项。不能用模拟通过代替真实模型或 Windows 进程验证。

- [ ] 编写扩展宿主测试：活动栏可打开、ready 重建状态、中文未保存选区附件正确、无/多根工作区处理、非信任/远程工作区拒绝启动、销毁扩展后子进程清理；运行 `npm run test:vscode`，有实现缺口时先记录失败再修复；已经满足的场景直接保留通过证据，不人为制造失败。
- [ ] 运行 `npm run check`、`npm test`、`npm run test:integration`、`npm run test:vscode`、`npm run compile`、`npm run package`，要求全部 exit 0；失败必须定位并修复后再继续。
- [ ] 实际安装生成的 VSIX，在本机 PI 1.5.2 中按下表验收。只在专用临时工程做会写文件的真实任务；缺少有效登录/模型/图片能力/MCP 时记录具体未验证项，不宣称全部通过。
- [ ] 按设计 3.8 对照真实 PI 的用户消息、助手正文、工具三种状态、输入区和 footer，记录 VS Code 明暗/高对比度、320px / 480px 侧栏和 200% 缩放截图；修复可读性和布局差异后再完成视觉验收。补充安装前提、PI 路径设置、模型/技能继承方式、P0/P1/P2 完成范围及已知限制；检查 VSIX 内容不包含测试夹具、会话正文、PI 安装副本或凭证；README 不宣传逐项变更审批或文件回滚。
- [ ] 仅在对应阶段验收完成后提交 `chore: validate and package PI sidebar extension`；交付 VSIX 路径和实际验证结果，不自动发布市场。

| 验收组 | 必须检查 |
| --- | --- |
| 连接 | PI 缺失、错误路径、含空格/中文路径、登录错误、PI 项目信任错误、Node 不可用、进程异常退出 |
| 聊天与附件 | 真正流式回复、停止、思考折叠、中文输入法、未保存选区、图片模型切换、长消息和代码块 |
| 工具与资源 | read/edit/write/命令的不同输出、修改后 diff、未知/MCP 工具、图片结果、没有 diff 时不伪造 |
| 会话与队列 | 新建/恢复/改名、取消切换、followUp/steer、清队列再停止、隐藏侧栏、重载 Webview |
| P1 状态 | `/` 技能与模板、统计缺失/null、压缩成功/失败、重试开始/结束/取消 |
| P2 状态 | 分叉/复制取消、树只读、导出路径、扩展请求取消/超时、独立命令取消和上下文排除 |
| PI 视觉 | PI 消息/工具/输入区/footer 对照、明暗及高对比度、320px / 480px、200% 缩放、截图记录 |
| 发布 | 键盘可达性、CSP、Windows 子进程清理、VSIX 实际安装 |

## 7. 范围覆盖与实施备注

| 设计内容 | 对应任务 |
| --- | --- |
| 进程隔离、协议、兼容性、工作区信任 | 1–3 |
| 聊天、思考、工具与已有编辑差异 | 4 |
| 选区、文件和图片 | 5 |
| 模型、思考强度、技能/模板/扩展命令 | 6 |
| 基础会话、恢复、命名和持久索引 | 7 |
| steer/followUp、停止和重试 | 8，基础停止在 4 |
| 用量、上下文占用、压缩 | 9 |
| 会话分叉、复制、只读树与 HTML | 10 |
| 扩展确认/选择/输入、状态、MCP 和命令面板 | 基础交互在 4，增强在 11 |
| PI 视觉规范、主题、安全、真实验证和打包 | 1、4、9、11、12 |

以上步骤均为待办，未表示代码存在或测试已经通过。开发者按顺序逐项勾选并提交，每个阶段完成后更新实际验证记录。若发现某能力必须嵌入 SDK、注入新 PI 扩展或自行实现智能体策略才能完成，回到设计边界讨论，不默默扩大实现。
